# POST /api/v1/moderate/audio

Moderate a generated audio clip (for example AI-voiced speech). Call it **after**
generation, before the audio is published. The clip is transcribed, and the transcript
runs through the same keyword blocklist and LLM prohibition check as text moderation.

This moderates **transcribed speech** only — music, sound effects, and other non-verbal
audio are not classified. The transcript is never stored and never returned.

Requires the `moderate:audio` scope.

## Request

`multipart/form-data` fields:

| Field         | Type   | Required | Description                                                             |
| ------------- | ------ | -------- | ----------------------------------------------------------------------- |
| `audio`       | string | Yes      | Publicly reachable HTTP(S) URL of the clip, ≤ 100 MB and ≤ 30 minutes.  |
| `webhook_url` | string | No       | URL to receive the result on completion.                                |

A URL with another scheme, or one that resolves to a private or internal network
address, is rejected with `400 INVALID_REQUEST`.

```js
const form = new FormData();
form.append('audio', generatedAudioUrl);

const res = await fetch('https://api.omnifence.ai/api/v1/moderate/audio', {
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
curl -X POST https://api.omnifence.ai/api/v1/moderate/audio \
  -H "Authorization: Bearer $OMNIFENCE_API_KEY" \
  -F "audio=https://example.com/clip.mp3"
```

## Response

`202 Accepted`:

```json
{ "job_id": "c3d4e5f6-a7b8-9012-cdef-123456789012", "status": "queued" }
```

## Completed job

Same shape as text moderation: `is_prohibited` plus a `reason` on a rejection. A
rejection `reason` is model-generated text scrubbed of verbatim quotation on a
best-effort basis; it may paraphrase what was said.
