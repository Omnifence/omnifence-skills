# POST /api/v1/moderate/text/batch

Moderate up to 99 texts in one request, with one decision for each text. Use it when one
user action produces several texts that each need their own decision — the fields of a
character or profile form, for example — so the integration can mark the exact field that
was rejected.

Requires the `moderate:text` scope. Reading a batch requires `job:read`.

## Why a batch, not one call per field

- **Rate limit.** One batch request counts as **one** request against the per-client rate
  limit (60 per minute and 6 per second by default), whatever the number of items. One
  `/moderate/text` call per field, plus a poll per job, exhausts that budget at a few form
  saves per second and returns `429`.
- **One webhook.** The batch sends one webhook when every item has settled. Items send no
  webhook of their own.
- **Same decisions.** Each item is checked on its own, exactly as a single `/moderate/text`
  submit checks it. The model never sees the other items. Do not join fields into one text
  to save calls: one combined decision cannot say which field failed.
- **Same billing.** Each item is billed as one text moderation job.

## Request

`application/json` body (not multipart):

| Field          | Type   | Required | Description                                                                                 |
| -------------- | ------ | -------- | ------------------------------------------------------------------------------------------- |
| `items`        | array  | Yes      | 1 to 99 items.                                                                              |
| `items[].key`  | string | Yes      | The integration's name for the item, unique in the batch. 1 to 64 of `A-Z a-z 0-9 _ . : -`. |
| `items[].text` | string | Yes      | The text to moderate, ≤ 20,000 characters.                                                  |
| `webhook_url`  | string | No       | Receives the one batch webhook. Overrides the account's global webhook for this batch.      |

Use the form field name as the `key`, so the decision maps straight back to the field.
Send only non-empty fields: an empty `text` refuses the whole batch.

```js
const res = await fetch('https://api.omnifence.ai/api/v1/moderate/text/batch', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OMNIFENCE_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    items: Object.entries(fields)
      .filter(([, text]) => text.trim() !== '')
      .map(([key, text]) => ({ key, text })),
  }),
});
```

## Response

`202 Accepted`. Store `batch_id` with the held form, and each `job_id` with its field:

```json
{
  "batch_id": "96cf89a8-4baa-44a4-a953-010f4486882d",
  "status": "processing",
  "items": [
    { "key": "name", "job_id": "b4c38526-b18b-431c-ab54-9e3b82bf26f0" },
    { "key": "backstory", "job_id": "6c3f2e78-a17a-44a9-b259-d3344eee8bf3" }
  ]
}
```

Each item is an ordinary text job: `GET /api/v1/job/{job_id}` reads it, and also returns its
`batch_id` and `batch_key`.

## Errors

The batch is accepted whole or refused whole. A `400` creates no job and charges nothing;
fix the request, do not retry it unchanged. The message names the item.

| Status | Code                 | Cause                                                                   |
| ------ | -------------------- | ----------------------------------------------------------------------- |
| `400`  | `BATCH_EMPTY`        | `items` holds no item. Do not call the endpoint when no field has text. |
| `400`  | `BATCH_TOO_LARGE`    | More than 99 items. Split into several batches.                         |
| `400`  | `DUPLICATE_ITEM_KEY` | Two items share a `key`.                                                |
| `400`  | `TEXT_TOO_LONG`      | An item's `text` is over 20,000 characters. Split it into chunk items (`backstory.1`, `backstory.2`) and fail the field if any chunk is rejected. |
| `400`  | `INVALID_REQUEST`    | Not JSON, `items` missing, or a `key`/`text` invalid or empty.          |
| `402`  | `PAYMENT_REQUIRED`   | The balance does not cover every item. No item was accepted.            |

`429`, `500`, `503 SERVICE_UNAVAILABLE` and the other codes behave as in
`submission-errors.md`.

**`503 SUBMISSION_STATUS_UNKNOWN`** carries a `batch_id` instead of a `job_id`. Hold the form
against it and read `GET /api/v1/moderate/text/batch/{batch_id}`: a batch that exists was
accepted with all its items; `404 BATCH_NOT_FOUND` means no item was accepted — submit once
more. Never resubmit before that check: it creates and bills a second batch.

## The batch webhook

Sent once, when every item is `completed` or `failed`. It carries `type: "text_batch"` — a
job webhook has no `type` — so a handler that receives both must branch on `type` first
(see `webhook-handler.md`).

```json
{
  "type": "text_batch",
  "batch_id": "96cf89a8-4baa-44a4-a953-010f4486882d",
  "status": "completed",
  "created_at": "2026-10-06T14:02:01.249Z",
  "completed_at": "2026-10-06T14:02:03.494Z",
  "items": [
    { "key": "backstory", "job_id": "6c3f2e78-a17a-44a9-b259-d3344eee8bf3", "status": "completed", "is_prohibited": true, "reason": "The text contained a blacklisted keyword." },
    { "key": "name", "job_id": "b4c38526-b18b-431c-ab54-9e3b82bf26f0", "status": "completed", "is_prohibited": false },
    { "key": "tagline", "job_id": "9c8a428b-be51-4776-86ba-e013f4d519fb", "status": "failed", "is_prohibited": null, "error_code": "PROVIDER_TIMEOUT" }
  ],
  "delivery_id": "wh_batch_96cf89a8-4baa-44a4-a953-010f4486882d"
}
```

- The batch `status` is always `completed` here. A failed item shows it in its own `status`.
- Items are ordered by `key`. Match by `key`, never by position.
- Each item has the same meaning as a job webhook: `is_prohibited` (`true`, `false`, or
  `null` on a failed item), `reason` on a rejection, `error_code` on a failure.
- Signature, `delivery_id` deduplication and retries are the same as for a job webhook.

## Releasing the form

Release the saved form only when **every** item has `is_prohibited: false`. Then:

- Any item with `is_prohibited: true` → reject the save, and mark that `key`'s field in the
  UI with a generic message. The `reason` is for operators and logs only.
- Any item with `status: "failed"` → no decision for that field; keep the form held and
  treat moderation as unavailable for it (fail closed). It was refunded; resubmitting that
  text alone gets its decision.
- One item's outcome never changes another's.

## Reading a batch

`GET /api/v1/moderate/text/batch/{batch_id}` returns the same body as the webhook, without
`delivery_id`. Its `status` stays `processing` until every item settles; each item shows its
decision as soon as it has one. One read is one request against the rate limit. Use it to
reconcile a missed webhook (see `polling.md`), not as a tight poll loop.
`404 BATCH_NOT_FOUND` means the ID is unknown or belongs to another account.
