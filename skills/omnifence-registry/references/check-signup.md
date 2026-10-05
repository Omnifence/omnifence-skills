# Check a sign-up against the Shared Registry

Source: https://docs.omnifence.ai/registry/checking

`POST /api/v1/registry/check` needs a key with the `registry:check` scope and an active membership.

## Request

| Field         | Type   | Description                                                                                    |
| ------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `identifiers` | array  | One to five identifiers for **one** user. Each is `{ "type": "email", "sha256": "<digest>" }`. |
| `context`     | string | Why you check: `signup`, `login` or `periodic`.                                                |

Send every email the user gave (for example a login email and a recovery email) in one request.
Never put two users in one request: the result cannot say which of them matched.

```bash
curl -X POST https://api.omnifence.ai/api/v1/registry/check \
  -H "Authorization: Bearer $OMNIFENCE_REGISTRY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "identifiers": [
      { "type": "email", "sha256": "d6117306485ed0e50afab3ac871e98f81699151f30281527d63ff5f233656c69" }
    ],
    "context": "signup"
  }'
```

## Response (`200`)

```json
{
  "match": true,
  "signals": [
    {
      "category": "payment_fraud",
      "reporter_count": 1,
      "first_reported_at": "2026-05-11T14:02:00.000Z",
      "last_reported_at": "2026-05-11T14:02:00.000Z",
      "automated_refusal_permitted": false
    }
  ],
  "normalisation_version": 1
}
```

- `match`: `true` when at least one live entry matches any identifier.
- `signals`: one object per matching category, sorted by category. Empty when `match` is `false`.
  `reporter_count` counts members, not reports. The response never names a reporter.
- `normalisation_version`: the hashing rules the registry expects. Currently `1`.

## Decision

| Signals                                                | Action                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| None                                                   | Continue the sign-up.                                                               |
| At least one with `automated_refusal_permitted: true`  | The application may refuse the sign-up.                                             |
| Only signals with `automated_refusal_permitted: false` | Hold the account for review by a person, or apply extra verification. Never refuse automatically. |

Read `automated_refusal_permitted` from each signal. Do not hard-code which category allows a refusal:
Omnifence sets it per category, and the law (UK GDPR Art 22) is why the lower-severity categories need
a person in the loop.

## Implementation

```javascript
import { registryDigest } from './registry-hash.mjs';

const REGISTRY_CHECK_URL = 'https://api.omnifence.ai/api/v1/registry/check';

export async function checkRegistry(emails, context) {
  const identifiers = [...new Set(emails.filter(Boolean).map(registryDigest).filter(Boolean))]
    .slice(0, 5)
    .map((sha256) => ({ type: 'email', sha256 }));
  if (identifiers.length === 0) return { match: false, signals: [] };

  const response = await fetch(REGISTRY_CHECK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OMNIFENCE_REGISTRY_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ identifiers, context }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Registry check failed: ${response.status} ${body.error ?? ''}`.trim());
  }
  return response.json();
}

export function registryDecision(result) {
  if (!result.match) return 'allow';
  if (result.signals.some((signal) => signal.automated_refusal_permitted)) return 'refuse';
  return 'review';
}
```

```javascript
// In the sign-up handler, before the account becomes active
let decision = 'allow';
try {
  decision = registryDecision(await checkRegistry([email, recoveryEmail], 'signup'));
} catch (err) {
  // The registry is one signal, not a gate. Do not block sign-ups when it cannot
  // answer: record the user for a later re-check with context "periodic".
  console.warn(err);
}
```

## Fail open

A timeout, a `5xx`, or a `429` means "no answer". Continue the sign-up as if nothing matched, and
queue the user for a `periodic` re-check. Do not retry a check in a tight loop: every request counts
against the daily quota and the rate limit.

A `400`, `401`, or `403` is a bug or a configuration problem in the integration. Log it and alert the
team; still do not block the user.

## Daily quota

Each check request counts once against the member's daily quota, whatever number of identifiers it
carries. The count resets at 00:00 UTC. Over the quota the API returns `429 RATE_LIMITED` with the
message `Daily Shared Registry check quota of <quota> reached` and no `retry-after` header. The
account's normal rate limit (60 per minute, 6 per second by default) also applies, and its `429`
carries `retry-after`.

## What the end user sees

- Never tell the user that they are in the registry, which category matched, or how many platforms
  reported them. Show the application's normal message for a refused or held account.
- Give a refused or held user the application's usual route to contest the decision. A user who asks
  what the registry holds about them goes to https://docs.omnifence.ai/registry/disputes.
