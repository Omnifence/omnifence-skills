# Webhook handler

The preferred way to receive decisions. Register a global URL once, or pass a
`webhook_url` field on individual submissions (the per-request URL overrides the global
one for that job).

**Verify the signature before you act on a payload.** The webhook URL is not a secret.
Anyone who learns it can POST a forged `"is_prohibited": false` at the endpoint and
release content the moderation pipeline rejected. Signature verification is the only
thing that makes a callback provably ours. Build the handler in the order below —
verification first, business logic second.

## Register the global webhook

```bash
curl -X POST https://api.omnifence.ai/api/v1/webhook/register \
  -H "Authorization: Bearer $OMNIFENCE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-app.com/webhooks/omnifence"}'
```

Calling it again replaces the URL. `DELETE /api/v1/webhook/register` detaches it.

The URL must be valid public HTTPS. A URL that is not, or that resolves to a private
address, is never delivered to.

## Signature verification

Omnifence signs every callback with
[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks) — the same
scheme OpenAI, Anthropic, Twilio and Replicate use. Use an off-the-shelf library for the
target language. Do not hand-roll the HMAC.

### Headers

| Header                     | Value                                                        |
| -------------------------- | ------------------------------------------------------------ |
| `webhook-id`               | Unique id for this message. The same on every retry.         |
| `webhook-timestamp`        | When Omnifence signed **this attempt**, in Unix **seconds**. |
| `webhook-signature`        | One or more space-delimited `v1,<base64>` values.            |
| `X-Omnifence-Delivery-Id`  | The same value as `webhook-id` and the body's `delivery_id`. |

The signature is `HMAC-SHA256` over `{webhook-id}.{webhook-timestamp}.{raw request body}`,
keyed with the base64-decoded secret (the part after `whsec_`), base64 encoded and
prefixed with `v1,`.

### Sign the raw bytes

Read the body as raw bytes, exactly as received. `express.json()`, `body-parser`, and any
other JSON middleware parse and discard those bytes; re-serialising the object changes key
order and whitespace, and every check then fails. Mount the raw-body parser on the webhook
route only, so the rest of the application keeps its normal JSON parsing.

### The signing secret

The secret looks like `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw` and pastes straight into any
Standard Webhooks library. Read it from an environment variable — for example
`OMNIFENCE_WEBHOOK_SECRET` — never hard-code it, and never log it.

The account holder reads the value from the dashboard under **Account → Webhooks**, or
through the API:

| Method | Endpoint                                  | Purpose                                   |
| ------ | ----------------------------------------- | ----------------------------------------- |
| `GET`  | `/api/v1/me/webhook-secrets`              | Secret metadata. Never the value.         |
| `POST` | `/api/v1/me/webhook-secrets/reveal`       | Return the active secret in full.         |
| `POST` | `/api/v1/me/webhook-secrets/rotate`       | Issue a new secret, return it.            |

These three need the `webhook:manage` scope, which is **off by default on API keys**. A
plain `moderate:*` integration key gets `403 FORBIDDEN`. That is deliberate: a key that can
read the signing secret can forge deliveries. Ask the user to paste the secret from the
dashboard rather than requesting the scope on the integration key.

### Timestamp tolerance

Standard Webhooks libraries reject a `webhook-timestamp` more than **five minutes** from
their own clock, which stops a replay of a captured delivery. Do not widen it. Each attempt
is signed as it is sent, so a retry hours later carries a fresh timestamp and a fresh
signature and passes the default tolerance.

### Rotation

After a rotation the previous secret keeps signing for **24 hours**, so deliveries stay
verifiable while the new value is deployed. During that window `webhook-signature` carries
two space-delimited values:

```
webhook-signature: v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE= v1,bm90LWEtcmVhbC1zaWduYXR1cmUtZXhhbXBsZS0xMjM0NQ==
```

A Standard Webhooks library tries each value and accepts the message if one matches, so the
handler needs no change beyond swapping the secret. Only one previous secret is kept, so
the header never carries more than two signatures.

## Payload

Omnifence POSTs a JSON body when a job completes:

```json
{
  "is_prohibited": true,
  "reason": "The text requests sexual content involving a minor.",
  "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "completed",
  "completed_at": "2026-05-19T12:00:01.500Z",
  "delivery_id": "wh_a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

- `reason` is present only when `is_prohibited` is `true`. It names the policy or the
  custom category that tripped — see `account-config.md`.
- `nsfw` appears only on image/video jobs with the NSFW check enabled; it is
  informational and never a rejection by itself.
- There is no `type` field in the payload — match `job_id` against the job IDs stored at
  submission time to know which content the decision belongs to. (`GET /api/v1/job/{id}`
  does return `type`.)
- `delivery_id` is stable across retries of the same result — use it to deduplicate
  redeliveries.

## Handler example (Express)

```js
import { Webhook } from 'standardwebhooks';
import express from 'express';

const app = express();
const wh = new Webhook(process.env.OMNIFENCE_WEBHOOK_SECRET);

// express.raw, not express.json — the signature covers the bytes on the wire.
// The handler must be fast and must return 2xx to acknowledge receipt. A non-2xx
// response or a timeout (10s) triggers retries with exponential backoff — 12
// attempts over about five hours.
app.post('/webhooks/omnifence', express.raw({ type: 'application/json' }), async (req, res) => {
  let payload;
  try {
    payload = wh.verify(req.body, req.headers); // throws on a bad or stale signature
  } catch {
    return res.status(400).send('invalid signature'); // never a 2xx — do not ack a forgery
  }

  const { job_id, is_prohibited, reason, delivery_id } = payload;

  if (await alreadyProcessed(delivery_id)) {
    return res.sendStatus(200); // duplicate redelivery
  }

  const content = await findHeldContentByJobId(job_id);
  if (!content) return res.sendStatus(200); // unknown job — ack anyway

  if (is_prohibited) {
    await markRejected(content, reason); // reason is for operators/logs only
  } else {
    await release(content); // the only path that publishes content
  }

  await markProcessed(delivery_id);
  res.sendStatus(200);
});
```

Libraries exist for Python, Go, Rust, Java, Kotlin, Ruby, PHP, C# and Elixir. Match the
codebase's language rather than porting the Node example.

## Reliability

Webhook delivery can be abandoned after the retry window, so do not rely on it alone:
run a low-frequency reconciliation poll of
`GET /api/v1/jobs?status=queued,processing` (see `polling.md`) to catch any held
content whose decision never arrived, and read the final result from
`GET /api/v1/job/{id}`. A lost delivery must leave the content held, not published.
