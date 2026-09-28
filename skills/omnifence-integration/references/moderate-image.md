# POST /api/v1/moderate/image

Moderate a generated image. Call it **after** generation, before the image is published
or shown to an end user.

Requires the `moderate:image` scope.

## Request

`multipart/form-data` fields:

| Field         | Type   | Required | Description                                              |
| ------------- | ------ | -------- | -------------------------------------------------------- |
| `image`       | string | Yes      | Publicly reachable HTTP(S) URL of the image, ≤ 10 MB.    |
| `webhook_url` | string | No       | URL to receive the result on completion.                 |

The classifiers fetch the URL directly. A URL with another scheme, or one that resolves
to a private or internal network address, is rejected with `400 INVALID_REQUEST`. A
presigned bucket URL works — make sure it stays valid for at least several minutes.

```js
// submitModeration() is the helper in submission-errors.md. It returns the job ID —
// including the recovery ID of a 503 SUBMISSION_STATUS_UNKNOWN, flagged by
// acceptanceUnknown — and throws on every other error. Store both with the held content.
const { jobId, acceptanceUnknown } = await submitModeration('image', { image: generatedImageUrl });
```

```bash
curl -X POST https://api.omnifence.ai/api/v1/moderate/image \
  -H "Authorization: Bearer $OMNIFENCE_API_KEY" \
  -F "image=https://example.com/photo.jpg"
```

## Response

`202 Accepted`:

```json
{ "job_id": "8298ed3d-b2e9-409d-9084-bb481934476a", "status": "queued" }
```

## Completed job

```json
{
  "is_prohibited": false,
  "nsfw": false,
  "job_id": "8298ed3d-b2e9-409d-9084-bb481934476a",
  "status": "completed",
  "completed_at": "2026-08-10T16:42:49.655Z"
}
```

`nsfw` is an informational label — it never causes a rejection on its own, and it is
omitted when the client has disabled the NSFW check. A rejection adds a `reason` string.
