# POST /api/v1/moderate/video

Moderate a generated video. Call it **after** generation, before the video is published
or shown to an end user. The whole clip is sent to a video-capable vision model — the
same checks as image moderation, applied to the full clip.

Requires the `moderate:video` scope.

## Request

`multipart/form-data` fields:

| Field         | Type   | Required | Description                                                                         |
| ------------- | ------ | -------- | ----------------------------------------------------------------------------------- |
| `video`       | string | Yes      | Publicly reachable HTTP(S) URL of an MP4, WebM or QuickTime file, ≤ 100 MB.        |
| `webhook_url` | string | No       | URL to receive the result on completion.                                            |

A URL with another scheme, or one that resolves to a private or internal network
address, is rejected with `400 INVALID_REQUEST`.

The URL must link directly to the video file. The API probes it before it accepts the job,
and rejects the request without creating a job or charging the account when:

- the file is larger than 100 MB → `413 PAYLOAD_TOO_LARGE`;
- the URL serves something other than a video file — an HLS playlist (`.m3u8`), a DASH
  manifest, an HTML player page → `415 UNSUPPORTED_MEDIA`;
- the origin refuses the URL (HTTP 404 or 403, an expired signed link) →
  `422 MEDIA_UNREACHABLE`.

Streaming manifests are never accepted. If the generator produces HLS or DASH output, find
where it writes a single MP4 rendition and submit that. None of these three succeeds on a
retry of the same URL — see `submission-errors.md`.

```js
// submitModeration() is the helper in submission-errors.md. It returns the job ID —
// including the recovery ID of a 503 SUBMISSION_STATUS_UNKNOWN, flagged by
// acceptanceUnknown — and throws on every other error. Store both with the held content.
const { jobId, acceptanceUnknown } = await submitModeration('video', { video: generatedVideoUrl });
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
