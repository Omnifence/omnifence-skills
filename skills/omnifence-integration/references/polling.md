# Polling for decisions

Use polling when the integration cannot expose a public HTTPS webhook endpoint, and as a
low-frequency reconciliation pass alongside webhooks.

## Which endpoint to poll

- **Many jobs in flight:** `GET /api/v1/jobs?status=queued,processing` — one request
  covers every outstanding job, whatever the count. When a job disappears from this list,
  fetch its result once via `GET /api/v1/job/{id}`.
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

A `failed` job never reached a moderation decision (`error_code` says why). Treat it
exactly like a timeout: the content stays held; retry the submission or surface it to an
operator.
