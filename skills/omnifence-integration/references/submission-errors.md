# Submission errors

A submission returns `202` with a `job_id`, or an error. Errors are JSON:
`{ "error": "CODE", "message": "...", "statusCode": 400 }`. On every error the content
stays held — fail closed.

Most errors fall into two groups: retry the same request later, or stop and fix something
first. Two need their own handling: `503 SUBMISSION_STATUS_UNKNOWN` (the job may exist) and
`403 ACCOUNT_TERMINATED` (nothing more will succeed).

## Error codes

| Status | Code                        | Meaning                                                                                  | Action                                                                                          |
| ------ | --------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `400`  | `INVALID_REQUEST`           | A bad or missing field, text over 20,000 characters, another field over 16,384 bytes, or a URL that is private or not HTTP(S).    | Do not retry the same request. Fix the input.                                                   |
| `401`  | `UNAUTHORIZED`              | The key is missing, invalid, or inactive.                                                | Stop. Fix the key.                                                                              |
| `402`  | `PAYMENT_REQUIRED`          | The account credit balance is at or below zero.                                          | Stop submitting. Alert an operator. Jobs already accepted still complete.                       |
| `403`  | `FORBIDDEN`                 | The key lacks the scope this endpoint needs.                                             | Stop. Fix the key's scopes.                                                                     |
| `403`  | `ACCOUNT_TERMINATED`        | The account is terminated. Not recoverable through the API.                              | Stop every submission and poll. Alert an operator.                                              |
| `413`  | `PAYLOAD_TOO_LARGE`         | The media behind the URL is over the endpoint's limit, or the form has more than eight non-file fields. No job, no charge. | Do not retry the same request. Handle as undecidable, or submit a smaller file.                 |
| `415`  | `UNSUPPORTED_MEDIA`         | The URL serves something that is not a media file — an HLS or DASH manifest, a web page. | Do not retry the same URL. Submit a direct link to the file (MP4, WebM or QuickTime for video). |
| `422`  | `MEDIA_UNREACHABLE`         | The origin refused the URL — HTTP 404, 403, or an expired signed link. No job, no charge. | Do not retry the same URL. Mint a fresh URL, then resubmit.                                     |
| `429`  | `RATE_LIMITED`              | Over the per-client rate limit.                                                          | Wait `retry-after` seconds, then retry.                                                         |
| `500`  | `INTERNAL_ERROR`            | An unexpected server error.                                                              | Retry with exponential backoff and jitter.                                                      |
| `503`  | `SERVICE_UNAVAILABLE`       | Intake is busy, or a dependency is down.                                                 | Wait at least `retry-after` seconds when it is sent, then retry with backoff and jitter.        |
| `503`  | `SUBMISSION_STATUS_UNKNOWN` | The API could not confirm whether it accepted the job. The body carries a `job_id`.      | **Do not resubmit.** Poll that `job_id` first — see below.                                      |

`415`, `422`, and a media-size `413` come from a probe of the media URL at submission time
(video today).
The same `MEDIA_UNREACHABLE` and `UNSUPPORTED_MEDIA` can also arrive later as the
`error_code` of a failed job, when the classifier could not fetch or open the media — see
`polling.md`.

## `503 SUBMISSION_STATUS_UNKNOWN`

The submission may have been accepted. The body carries the `job_id` it would have:

```json
{
  "error": "SUBMISSION_STATUS_UNKNOWN",
  "message": "...",
  "statusCode": 503,
  "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

Store that `job_id` beside the held content exactly as if the submission returned `202`, and
poll `GET /api/v1/job/{id}`:

- The job exists → it was accepted and is running. Wait for its decision as normal.
- `404 JOB_NOT_FOUND` → it was not accepted. Submit again.

Resubmitting without that check can create a second job for the same content, and the
account pays for both. A retry loop that treats every `503` alike does exactly that.

## Submit helper

One helper that every layer calls keeps these rules in one place:

```js
export class OmnifenceSubmitError extends Error {
  constructor(status, body, { retryable, retryAfterMs }) {
    super(`Omnifence submission failed: ${status} ${body.error} — ${body.message}`);
    this.status = status;
    this.code = body.error;
    this.retryable = retryable;       // true: the same request may succeed later
    this.retryAfterMs = retryAfterMs; // from `retry-after` when the API sent it
  }
}

/**
 * Returns `{ jobId, acceptanceUnknown }`. Store both beside the held content.
 * Throws on every other outcome.
 */
export async function submitModeration(endpoint, fields) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);

  const res = await fetch(`https://api.omnifence.ai/api/v1/moderate/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OMNIFENCE_API_KEY}` },
    body: form,
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 202) return { jobId: body.job_id, acceptanceUnknown: false };

  // The job may exist. Hand back its ID so the caller holds the content against it
  // and polls, rather than submitting a second, separately billed job.
  if (res.status === 503 && body.error === 'SUBMISSION_STATUS_UNKNOWN' && body.job_id) {
    return { jobId: body.job_id, acceptanceUnknown: true };
  }

  const retryAfter = Number(res.headers.get('retry-after'));
  throw new OmnifenceSubmitError(res.status, body, {
    retryable: res.status === 429 || res.status === 500 || res.status === 503,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
  });
}
```

Holding the content against the recovery `job_id` is safe: the poll loop (or the
reconciliation pass) finds either a decision or `404 JOB_NOT_FOUND`. For an ordinary job,
`polling.md` treats that `404` as "stop and keep the content held". For a job stored with
`acceptanceUnknown: true`, a `404` means the submission never landed — resubmit it once,
and store the new job ID in its place.

Never retry a non-retryable error in a loop. `402`, `403`, `413`, `415` and `422` fail the
same way every time and spend the rate-limit budget the rest of the integration needs.
