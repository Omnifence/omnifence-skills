# POST /api/v1/moderate/text

Moderate a user-written generation prompt or an AI-character chat turn. Call it **before**
the generation request, and hold the generation until the job passes.

Requires the `moderate:text` scope.

## Request

`multipart/form-data` fields:

| Field         | Type   | Required | Description                                |
| ------------- | ------ | -------- | ------------------------------------------ |
| `text`        | string | Yes      | The text to moderate, ≤ 20,000 characters. |
| `webhook_url` | string | No       | URL to receive the result on completion.   |

Text over 20,000 characters is rejected with `400 INVALID_REQUEST` before a job is created or
billed. Do not truncate it silently — the cut-off part would pass unchecked. Split longer text
into chunks, submit each chunk as its own job, and release the text only when every chunk
passes.

```js
// submitModeration() is the helper in submission-errors.md. It returns the job ID —
// including the recovery ID of a 503 SUBMISSION_STATUS_UNKNOWN, flagged by
// acceptanceUnknown — and throws on every other error. Store both with the held content.
const { jobId, acceptanceUnknown } = await submitModeration('text', { text: userPrompt });
```

```bash
curl -X POST https://api.omnifence.ai/api/v1/moderate/text \
  -H "Authorization: Bearer $OMNIFENCE_API_KEY" \
  -F "text=A beautiful sunset over the ocean"
```

## Response

`202 Accepted`:

```json
{ "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890", "status": "queued" }
```

## Completed job (webhook payload or `GET /api/v1/job/{id}`)

```json
{
  "is_prohibited": true,
  "reason": "The text requests sexual content involving a minor.",
  "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "completed",
  "completed_at": "2026-05-19T12:00:01.500Z"
}
```

Text that passes returns `is_prohibited: false` with no `reason`.

## Chat turns

There is no dedicated chat endpoint. Moderate each turn as plain text: the user's message
before it reaches the model, and (optionally, per the user's requirements) the model's
reply before it reaches the end user. Submit each turn as its own job and hold that turn
— not the whole conversation — on its decision.
