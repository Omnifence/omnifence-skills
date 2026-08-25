# Webhook handler

The preferred way to receive decisions. Register a global URL once, or pass a
`webhook_url` field on individual submissions (the per-request URL overrides the global
one for that job).

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

- `reason` is present only when `is_prohibited` is `true`.
- `nsfw` appears only on image/video jobs with the NSFW check enabled; it is
  informational and never a rejection by itself.
- There is no `type` field — match `job_id` against the job IDs you stored at
  submission time to know which content the decision belongs to.
- `delivery_id` (also sent as the `X-Omnifence-Delivery-Id` header) is stable across
  retries of the same result — use it to deduplicate redeliveries.

## Handler example (Express)

```js
// The handler must be fast and must return 2xx to acknowledge receipt.
// A non-2xx response or a timeout (10s) triggers retries with exponential
// backoff — 12 attempts over about five hours.
app.post('/webhooks/omnifence', express.json(), async (req, res) => {
  const { job_id, is_prohibited, reason, delivery_id } = req.body;

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

## Reliability

Webhook delivery can be abandoned after the retry window, so do not rely on it alone:
run a low-frequency reconciliation poll of
`GET /api/v1/jobs?status=queued,processing` (see `polling.md`) to catch any held
content whose decision never arrived, and read the final result from
`GET /api/v1/job/{id}`. A lost delivery must leave the content held, not published.
