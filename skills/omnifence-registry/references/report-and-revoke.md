# Report a banned user, list reports, and revoke a report

Source: https://docs.omnifence.ai/registry/reporting

All three endpoints need a key with the `registry:submit` scope and an active membership.

## Report: `POST /api/v1/registry/entries`

| Field                 | Type    | Description                                                                                |
| --------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `identifier`          | object  | `{ "type": "email", "sha256": "<digest>" }`. See `hashing.md`.                             |
| `category`            | string  | `payment_fraud`, `prohibited_content` or `ban_evasion`.                                    |
| `member_case_ref`     | string  | The application's own case or ticket ID, 1 to 200 characters. No personal data, no content. |
| `attest_human_review` | boolean | Must be `true`: a person reviewed the evidence and upheld the ban.                         |

A report is allowed only when all of these are true:

- A person on the member's team reviewed the evidence and upheld the ban. Send
  `attest_human_review: true` only from a code path that a human decision reaches. Never from an
  automated ban, a classifier score, or an Omnifence moderation rejection.
- The ban is for one of the three categories, and the membership allows that category (otherwise
  `403 FORBIDDEN`). Ask the user how their ban reasons map to the categories; do not guess.
- The member keeps the evidence under `member_case_ref` in its own system.

```javascript
import { registryDigest } from './registry-hash.mjs';

export async function reportToRegistry({ email, category, caseRef }) {
  const sha256 = registryDigest(email);
  if (sha256 === null) return null;

  const response = await fetch('https://api.omnifence.ai/api/v1/registry/entries', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OMNIFENCE_REGISTRY_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      identifier: { type: 'email', sha256 },
      category,
      member_case_ref: caseRef,
      attest_human_review: true,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Registry report failed: ${response.status} ${body.error ?? ''}`.trim());
  }
  return response.json(); // the entry: store entry_id with the case
}
```

`201` means a new entry. `200` means the member already reported this identifier in this category, and
the registry refreshed that entry: new `member_case_ref`, retention restarted, reactivated if it was
revoked or expired. A refresh never ends an open dispute. Reporting again is therefore safe to retry.

The response is the entry:

```json
{
  "entry_id": "4f01b81e-6ccb-4cb4-8dcc-b5e9b52bf72a",
  "identifier_type": "email",
  "category": "payment_fraud",
  "member_case_ref": "TS-48213",
  "status": "active",
  "has_open_dispute": false,
  "created_at": "2026-10-02T09:30:00.000Z",
  "updated_at": "2026-10-02T09:30:00.000Z",
  "expires_at": "2028-10-01T09:30:00.000Z",
  "revoked_at": null,
  "revoke_reason": null
}
```

Store `entry_id` against the ban case. The revoke call needs it.

- Report each email the user used, one request per email.
- When a banned user comes back with a new account, report the new email as `ban_evasion` **and** in
  the original category.
- A failed report leaves other members unprotected. Send reports through a queue or job that retries
  `429` and `5xx` with backoff until it succeeds. Fix `400` and `403` instead of retrying.

## List: `GET /api/v1/registry/entries`

Query parameters: `limit` (1 to 200, default 50), `cursor` (the previous page's `next_cursor`; omit for
the first page), `status` (`active`, `disputed`, `revoked` or `expired`). The response is
`{ "entries": [...], "next_cursor": "<opaque>" | null }`, newest first, own entries only, and never
the identifier hash. Treat the cursor as opaque.

A `disputed` entry means the person named challenged the report and Omnifence will ask for the
evidence. If the application has an admin area, offer to surface disputed entries there.

## Revoke: `POST /api/v1/registry/entries/{id}/revoke`

Body: `{ "reason": "<1 to 500 characters>" }`. Call it at once when a ban is overturned (appeal,
mistake, or any other reason): other members may be refusing the person because of the report.

```javascript
export async function revokeRegistryReport(entryId, reason) {
  const response = await fetch(
    `https://api.omnifence.ai/api/v1/registry/entries/${encodeURIComponent(entryId)}/revoke`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OMNIFENCE_REGISTRY_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason }),
    },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Registry revoke failed: ${response.status} ${body.error ?? ''}`.trim());
  }
  return response.json(); // the entry, status "revoked"
}
```

The entry stops matching immediately, any open dispute on it closes, and Omnifence deletes it 30 days
later. Revoking twice is safe (`200`, unchanged). `404 NOT_FOUND` means the entry does not exist or
another member reported it.
