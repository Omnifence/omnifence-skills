# POST /api/v1/moderate/video

Moderate a generated video. Call it **after** generation, before the video is published
or shown to an end user. The whole clip is sent to a video-capable vision model — the
same checks as image moderation, applied to the full clip.

Requires the `moderate:video` scope.

## Request

`multipart/form-data` fields:

| Field         | Type   | Required | Description                                            |
| ------------- | ------ | -------- | ------------------------------------------------------ |
| `video`       | string | Yes      | Publicly reachable HTTP(S) URL of the video, ≤ 300 MB. |
| `webhook_url` | string | No       | URL to receive the result on completion.               |

A URL with another scheme, or one that resolves to a private or internal network
address, is rejected with `400 INVALID_REQUEST`.

```js
const form = new FormData();
form.append('video', generatedVideoUrl);

const res = await fetch('https://api.omnifence.ai/api/v1/moderate/video', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.OMNIFENCE_API_KEY}` },
  body: form,
});

if (res.status !== 202) {
  const err = await res.json();
  throw new Error(`Omnifence submission failed: ${err.error} — ${err.message}`);
}

const { job_id } = await res.json();
```

```bash
curl -X POST https://api.omnifence.ai/api/v1/moderate/video \
  -H "Authorization: Bearer $OMNIFENCE_API_KEY" \
  -F "video=https://example.com/clip.mp4"
```

## Response

`202 Accepted`:

```json
{ "job_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901", "status": "queued" }
```

## Completed job

Same shape as image moderation: `is_prohibited`, optional `reason` on a rejection, and
the informational `nsfw` label when that check is enabled.
