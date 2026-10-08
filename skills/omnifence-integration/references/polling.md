# Polling for decisions

Use polling when the integration cannot expose a public HTTPS webhook endpoint, and as a
low-frequency reconciliation pass alongside webhooks.

## Which endpoint to poll

- **Many jobs in flight:** `GET /api/v1/jobs?status=queued,processing` — one query covers
  every outstanding job, but the response is **paginated**: `limit` caps at 100 and
  defaults to 50. Page with `limit` and `offset` until you have all `total` rows. When a
  job disappears from the completed list, fetch its result once via
  `GET /api/v1/job/{id}`.
- **A single job:** `GET /api/v1/job/{id}` (requires the `job:read` scope).

## Pace on the rate-limit headers

Every response carries the account's live budget — read it instead of guessing:

| Header                  | Meaning                                             |
| ----------------------- | --------------------------------------------------- |
| `x-ratelimit-limit`     | Maximum requests allowed in the current window.     |
| `x-ratelimit-remaining` | Requests left in the current window.                |
| `x-ratelimit-reset`     | Seconds until the current window resets.            |
| `retry-after`           | Seconds to wait before retrying. Sent on a `429`.   |

Polls count against the same per-client limit as submissions, so a tight poll loop
starves your own submission path.

## Example

```js
async function pollJob(jobId, { intervalMs = 4000, timeoutMs = 10 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`https://api.omnifence.ai/api/v1/job/${jobId}`, {
      headers: { Authorization: `Bearer ${process.env.OMNIFENCE_API_KEY}` },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 5);
      await sleep(retryAfter * 1000);
      continue;
    }
    // 404 JOB_NOT_FOUND and 403 ACCOUNT_TERMINATED never become a decision. Stop
    // now rather than spinning to the timeout, and keep the content held.
    if (res.status === 404 || res.status === 403) {
      const { error, message } = await res.json();
      throw new Error(`Job unreachable: ${error} — ${message}`);
    }
    if (!res.ok) throw new Error(`Job lookup failed: ${res.status}`);

    const job = await res.json();
    if (job.status === 'completed') return job; // { is_prohibited, reason?, nsfw?, ... }
    if (job.status === 'failed') return job;    // treat as NOT a pass — keep content held

    // Slow down when the shared budget runs low.
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? Infinity);
    const reset = Number(res.headers.get('x-ratelimit-reset') ?? 1);
    const wait = remaining < 5 ? Math.max(intervalMs, (reset * 1000) / Math.max(remaining, 1)) : intervalMs;
    await sleep(wait);
  }

  // Timed out: the job may still complete later. Fail closed — keep the content held
  // and let a reconciliation pass pick the decision up.
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
```

A `failed` job never reached a moderation decision. Treat it like a timeout: the content
stays held. The charge is refunded, and the job ID cannot be retried — a resubmission is a
new job. The same outcome arrives as a `failed` webhook when the job has one.

`error_code` says why, when the pipeline knows. It is optional: never require it, and
treat an absent or unknown code as "resubmit once, then surface to an operator".

| `error_code`            | Meaning                                                              | Action                                                        |
| ----------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `PROVIDER_RATE_LIMITED` | The AI provider rate-limited the job past its retry window.          | Resubmit after a short delay.                                 |
| `PROVIDER_UNAVAILABLE`  | The AI provider returned server errors on every attempt.             | Resubmit after a short delay.                                 |
| `PROVIDER_TIMEOUT`      | The AI provider did not answer in time on every attempt.             | Resubmit after a short delay.                                 |
| `MODEL_UNAVAILABLE`     | The configured model is not served for this input.                   | Resubmit after a short delay.                                 |
| `MODEL_REFUSED`         | The model refused this exact input.                                  | Do not resubmit it unchanged. Handle as undecidable.          |
| `MEDIA_UNREACHABLE`     | The media URL did not resolve when fetched (404, expired signed URL). | Do not resubmit the same URL. Mint a fresh URL, then resubmit. |
| `UNSUPPORTED_MEDIA`     | The media could not be opened (a manifest, an unreadable container), or no frames could be sampled from it (one still image over a long audio track). | Do not resubmit the same URL. Submit a direct MP4/WebM/QuickTime file that contains moving video. |

Cap automatic resubmission — one or two attempts — so a persistent provider outage
surfaces to an operator instead of looping.

## Statuses that end the loop

| Response                  | Meaning                                                        | Action                                              |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `404 JOB_NOT_FOUND`       | The job ID does not exist, or belongs to another account.       | Stop polling. Content stays held. Alert an operator. |
| `403 ACCOUNT_TERMINATED`  | The account is terminated. Not recoverable through the API.     | Stop polling and every submission. Alert an operator.|
| `403 FORBIDDEN`           | The key is missing the `job:read` scope.                        | Stop polling. Fix the key.                           |
| `402 PAYMENT_REQUIRED`    | The account credit balance is at or below zero.                 | Stop submitting. Held jobs still complete.           |
| `404 BATCH_NOT_FOUND`     | The text batch ID does not exist, or belongs to another account. | Stop reading it. The form stays held. Alert an operator. |

Retrying any of these wastes the same rate-limit budget the submission path needs.

One exception: a job ID stored from a `503 SUBMISSION_STATUS_UNKNOWN` response
(`acceptanceUnknown: true`) that returns `404 JOB_NOT_FOUND` was never accepted. Resubmit
it once — see `submission-errors.md`.

## Text batches

A text batch (`moderate-text-batch.md`) is reconciled with one read,
`GET /api/v1/moderate/text/batch/{batch_id}`, not with one poll per item. It returns every
item's decision; release the form only when the batch `status` is `completed` and every item
has `is_prohibited: false`. Its items are also ordinary jobs, so they appear in
`GET /api/v1/jobs?status=queued,processing` like any other job.

A batch ID stored from a `503 SUBMISSION_STATUS_UNKNOWN` that returns `404 BATCH_NOT_FOUND`
was never accepted. Resubmit it once.

## Reconciling a whole batch

The response is `{ jobs, total, limit, offset }`. Never treat the first page as the whole
set — an integration that does silently drops every job past the first 100 and leaves their
content held forever.

```js
async function listInFlightJobIds() {
  const ids = new Set();
  const limit = 100; // the maximum the endpoint accepts
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url = `https://api.omnifence.ai/api/v1/jobs?status=queued,processing&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.OMNIFENCE_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Job list failed: ${res.status}`); // held content stays held
    const page = await res.json();

    total = page.total;
    for (const job of page.jobs) ids.add(job.job_id);
    if (page.jobs.length === 0) break; // defensive: never spin on an empty page
    offset += page.jobs.length;
  }

  return ids;
}
```

Then diff that set against the job IDs stored beside your held content. A held item whose
job ID is **absent** from the in-flight set has decided — read its result from
`GET /api/v1/job/{id}`. A held item still in the set is simply not finished.

The same endpoint also accepts `type`, `decision`, and `search`. For an audit trail rather
than a live loop, use `GET /api/v1/jobs/export?from=<ISO 8601>&to=<ISO 8601>`, which
streams a CSV of the window including `api_key_id`, `reason`, and one column per category.
See `account-config.md`.
