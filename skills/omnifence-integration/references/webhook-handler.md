# Webhook handler

The preferred way to receive decisions. Register a global URL once, or pass a
`webhook_url` field on individual submissions (the per-request URL overrides the global
one for that job).

Every job sends exactly one terminal callback: a `completed` result or a `failed` notice.
The handler must accept both — see [Payload](#payload).

**Verify the signature before you act on a payload.** The webhook URL is not a secret.
Anyone who learns it can POST a forged `"is_prohibited": false` at the endpoint and
release content the moderation pipeline rejected. Signature verification is the only
thing that makes a callback provably ours. Build the handler in the order below —
verification first, business logic second.

## Register the global webhook

The global URL decides who receives every verdict on the account, so setting it needs the
`webhook:manage` scope. That scope is **off by default on API keys**: an integration key
gets `403 FORBIDDEN` here. Do not ask for the scope on the integration key. Pick one:

- **The account holder sets the URL in the dashboard** under **Account → Webhooks**, where
  the session carries the scope. This is the default recommendation.
- **Pass `webhook_url` on every submission.** It needs no extra scope, overrides the global
  URL for that job, and suits an integration that submits from one place.

The API call, for a key that does carry `webhook:manage`:

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

These three need the same `webhook:manage` scope as registration, which is **off by
default on API keys**. A plain `moderate:*` integration key gets `403 FORBIDDEN`. That is
deliberate: a key that can read the signing secret can forge deliveries. Ask the user to paste the secret from the
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

## Validate the payload, not just the signature

A valid signature proves who sent the body. It proves nothing about what is in it.
Branch on `status` first, and release content only on a `completed` callback with an
**explicit `is_prohibited: false`**:

```js
status === 'completed' && typeof is_prohibited === 'boolean' // a decision
status === 'failed'                                          // no decision — keep held
```

A `failed` callback is a real, signed outcome, not a malformed body. Acknowledge it with a
`2xx`, keep the content held, and record the `error_code`. Answering it with a `400` makes
Omnifence redeliver it for hours, and the failure is never handled.

A truthiness check fails open. `is_prohibited` is `null` on a job that has not decided
yet, and a missing or renamed field is `undefined` — both are falsy, so `if (is_prohibited)
… else release()` publishes rejected content the moment a wrong-status callback, a producer
defect, or a schema change reaches the endpoint. Fail closed on any other shape: leave
the content held and let the reconciliation poll settle it.

## Deduplicate by claiming, before the side effect

`delivery_id` is stable across retries, so it is the idempotency key. Claim it with a
**unique constraint or a compare-and-set**, and claim it *before* the release or rejection,
not after. A read-then-write around the side effect leaves two windows open: two concurrent
retries both pass the check, and a crash after the release but before the write repeats the
side effect on the next attempt. At layer 1 that starts generation twice and submits the
layer 2 job twice.

Claiming first has one failure mode of its own: a process that dies mid-handler leaves the
delivery claimed and the content held, because the retry is dropped as a duplicate. That is
the right way round. Held content is recovered by the reconciliation poll; content released
twice is recovered by nothing. Guard the state transition on the content's current state as
well, so a replay cannot move it twice.

## Payload

Omnifence POSTs a JSON body when a job settles. A job that reached a decision sends a
`completed` result:

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

A job that used up its retries without a decision sends a `failed` notice instead. The
charge for it is refunded:

```json
{
  "is_prohibited": null,
  "error_code": "PROVIDER_RATE_LIMITED",
  "job_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
  "status": "failed",
  "failed_at": "2026-09-02T10:11:36.000Z",
  "delivery_id": "wh_c3d4e5f6-a7b8-9012-cdef-123456789012"
}
```

| Field           | Present          | Description                                                                 |
| --------------- | ---------------- | --------------------------------------------------------------------------- |
| `is_prohibited` | Always           | `true` rejected, `false` passed, `null` on a `failed` job.                   |
| `job_id`        | Always           | The job this outcome belongs to.                                             |
| `status`        | Always           | `completed` or `failed`. A job sends one of the two, never both.             |
| `completed_at`  | On `completed`   | When the decision was made.                                                  |
| `failed_at`     | On `failed`      | When the job failed for good.                                                |
| `delivery_id`   | Always           | Stable across retries of this delivery — the idempotency key.                |
| `reason`        | Rejections only  | Why the content was rejected.                                                |
| `nsfw`          | Image/video only | Informational label, when the NSFW check is on.                              |
| `error_code`    | `failed` only    | Why the job failed, when the pipeline knows. The values are in `polling.md`. |

- `reason` is present only when `is_prohibited` is `true`. It names the policy or the
  custom category that tripped — see `account-config.md`.
- `nsfw` appears only on image/video jobs with the NSFW check enabled; it is
  informational and never a rejection by itself.
- There is no `type` field in a job payload — match `job_id` against the job IDs stored at
  submission time to know which content the decision belongs to. (`GET /api/v1/job/{id}`
  does return `type`.)
- A **text batch** sends one webhook of its own shape, with `type: "text_batch"`, a
  `batch_id`, and an `items` array with one decision per `key`. Its items send no job
  webhook. Branch on `type` before any other check — see below and
  `moderate-text-batch.md`.
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

  // A text batch: one webhook for every item. A job webhook has no `type`.
  if (payload.type === 'text_batch') {
    return handleBatch(payload, res);
  }

  const { job_id, is_prohibited, reason, delivery_id, status, error_code } = payload;

  // The signature authenticated the sender, not the shape. Release only on an
  // explicit boolean false on a `completed` callback — `null`, undefined, or any
  // other type must never reach the release branch.
  const isDecision = status === 'completed' && typeof is_prohibited === 'boolean';
  const isFailure = status === 'failed';
  if (typeof job_id !== 'string' || typeof delivery_id !== 'string' || !(isDecision || isFailure)) {
    return res.status(400).send('unexpected payload'); // content stays held
  }

  // Claim before the side effect, on a unique constraint over delivery_id, so two
  // concurrent retries cannot both get through. Returns false if already claimed.
  if (!(await claimDelivery(delivery_id))) {
    return res.sendStatus(200); // duplicate redelivery
  }

  const content = await findHeldContentByJobId(job_id);
  if (!content) return res.sendStatus(200); // unknown job — ack anyway

  // Guard every transition on the content's current state so a replay is a no-op.
  if (isFailure) {
    // No decision. The content stays held; surface it for a resubmit or an operator.
    // error_code may be absent — never require it.
    await markModerationFailed(content, error_code);
  } else if (is_prohibited) {
    await markRejected(content, reason); // reason is for operators/logs only
  } else {
    await release(content); // the only path that publishes content
  }

  res.sendStatus(200);
});
```

For a batch, apply the same rules to every item, then decide the form once:

```js
async function handleBatch(payload, res) {
  const { batch_id, delivery_id, status, items } = payload;
  if (
    typeof batch_id !== 'string' ||
    typeof delivery_id !== 'string' ||
    status !== 'completed' ||
    !Array.isArray(items)
  ) {
    return res.status(400).send('unexpected payload'); // the form stays held
  }
  if (!(await claimDelivery(delivery_id))) return res.sendStatus(200);

  const form = await findHeldFormByBatchId(batch_id);
  if (!form) return res.sendStatus(200);

  // Match by key, never by position. A field with no item stays held.
  const byKey = new Map(items.map((item) => [item.key, item]));
  const rejected = [];
  let undecided = false;
  for (const key of form.moderatedKeys) {
    const item = byKey.get(key);
    if (item?.status === 'completed' && item.is_prohibited === false) continue;
    if (item?.status === 'completed' && item.is_prohibited === true) rejected.push(key);
    else undecided = true; // failed, missing, or malformed: no decision
  }

  if (rejected.length > 0) await rejectForm(form, rejected); // mark these fields
  else if (undecided) await markModerationFailed(form);      // held, fail closed
  else await releaseForm(form);                              // every field passed

  res.sendStatus(200);
}
```

Libraries exist for Python, Go, Rust, Java, Kotlin, Ruby, PHP, C# and Elixir. Match the
codebase's language rather than porting the Node example.

## Reliability

Webhook delivery can be abandoned after the retry window, so do not rely on it alone:
run a low-frequency reconciliation poll of
`GET /api/v1/jobs?status=queued,processing` (see `polling.md`) to catch any held
content whose decision never arrived, and read the final result from
`GET /api/v1/job/{id}`. A lost delivery must leave the content held, not published.
