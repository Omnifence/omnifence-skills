---
name: omnifence-registry
description: >-
  Integrate the Omnifence Shared Registry, the cross-platform list of banned users that vetted
  member platforms share. Use only when the user explicitly asks for the Shared Registry, the
  "Omnifence registry", "banned-user registry", "check sign-ups against banned users", "report a
  banned user to Omnifence", or the registry:check / registry:submit scopes. Hashes emails to the
  published spec, checks sign-ups with POST /api/v1/registry/check, reports human-reviewed bans
  with POST /api/v1/registry/entries, and revokes overturned bans. This is NOT content
  moderation: requests to add moderation, filter generated content, or integrate the Omnifence
  moderation API belong to the omnifence-integration skill, and never include the registry.
---

# Omnifence Shared Registry integration

The Shared Registry is a list of users that member platforms banned for serious harm. A member
reports a banned user's email as a SHA-256 digest; other members check new sign-ups against the
list and receive per-category signals. Omnifence never receives a plaintext email, and a check
never says which member reported the user.

**The registry is a separate product from content moderation.** It needs a separate membership and
a separate API key. A moderation integration never calls it, and this skill never adds moderation
calls. If the user asked for moderation, stop and use the `omnifence-integration` skill instead.

Base URL: `https://api.omnifence.ai`. Auth: `Authorization: Bearer <registry key>`. There is no SDK.
Full docs: https://docs.omnifence.ai/registry/overview

## Step 0 — Confirm membership and key

Ask the user before you write any code:

1. Is their organisation an **active Shared Registry member**? Membership is by vetting and a signed
   agreement (https://docs.omnifence.ai/registry/membership). A moderation customer is not a member
   automatically.
2. Do they hold a **registry key**, and which scopes does it carry: `registry:check`,
   `registry:submit`, or both? Omnifence issues these scopes only on a dedicated registry key. A
   moderation key returns `403 FORBIDDEN` on every registry route.
3. Which parts do they want: **check** sign-ups, **report** bans, or both? Build only those parts.

If they are not a member, stop. Point them to the membership page and write no registry code: the
API refuses every call until the membership is active.

Read the key from its own environment variable, `OMNIFENCE_REGISTRY_KEY`. Do not reuse the
moderation key's variable.

## Step 1 — Find the integration points

Scan the codebase and show the user what you found. Let them correct the list before you write code.

- **Account creation** (for checks): every path that creates an account, including social login,
  invitations, and admin-created accounts. The check runs before the account becomes active.
- **Login** (optional check, context `login`): only if the user wants to catch users that another
  member reported after they signed up here.
- **Ban decisions** (for reports): where a person on the trust and safety team bans a user. Note
  which ban reasons exist and ask the user how each maps to the registry categories. Automated bans
  do not qualify.
- **Unban and appeal flows** (for revokes): every path that lifts a ban.
- **The review surface**: where a held account goes for a person to review. If none exists, ask the
  user what a "held for review" account should be in this application before you build one.

## Step 2 — Add the hashing module first

Copy the reference implementation from `references/hashing.md` into one module, and add a unit test
that runs every test vector. Use that one module for every check and every report. Do not write your
own normalisation rules.

Never send, log, or store a plaintext email on the registry path. Only the 64-character lowercase hex
digest leaves the application.

## Step 3 — Check sign-ups

Follow `references/check-signup.md`:

- One user per request, up to five identifiers (every email the user gave), and a `context` of
  `signup`, `login`, or `periodic`.
- Decide from each signal's `automated_refusal_permitted`: a `true` signal may refuse, a match with
  only `false` signals goes to review by a person or extra verification. Never refuse those
  automatically.
- Fail open: a timeout, `5xx`, or `429` continues the sign-up and queues a `periodic` re-check.
- Never tell the end user that they matched, which category matched, or who reported them.

## Step 4 — Report human-reviewed bans

Follow `references/report-and-revoke.md`:

- Report only bans that a person reviewed and upheld, in a category the membership allows:
  `payment_fraud`, `prohibited_content`, or `ban_evasion`. `attest_human_review: true` is a legal
  statement, so send it only from a code path that a human decision reaches.
- **An Omnifence moderation rejection is not a registry report.** Never report a user because their
  content was rejected, flagged, or scored by any automated system.
- `member_case_ref` is the application's own case ID. No names, emails, or content details.
- Store the returned `entry_id` with the ban case.
- Send reports through a retrying job: retry `429` and `5xx` with backoff, fix `400` and `403`.

## Step 5 — Revoke overturned bans

When a ban is lifted for any reason, call `POST /api/v1/registry/entries/{id}/revoke` with the stored
`entry_id` and a reason. Wire this into every unban path from Step 1, so that no overturned ban stays
in the registry.

## Errors

The registry uses the standard error body `{ "error", "message", "statusCode" }`.

| Status | `error`               | Meaning and handling                                                                                                        |
| ------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`     | The body is wrong (digest format, more than five identifiers, unknown value, `attest_human_review` not `true`). Fix it.      |
| 401    | `UNAUTHORIZED`        | The key is missing, wrong, or revoked.                                                                                      |
| 403    | `FORBIDDEN`           | Missing scope, membership not active, or a category the membership does not allow. A configuration problem: alert the team. |
| 403    | `ACCOUNT_TERMINATED`  | The Omnifence account is terminated.                                                                                        |
| 404    | `NOT_FOUND`           | Revoke only: no such entry, or another member reported it.                                                                  |
| 429    | `RATE_LIMITED`        | Daily check quota (no `retry-after`) or the rate limit (wait `retry-after`). Checks fail open; reports retry later.         |
| 503    | `SERVICE_UNAVAILABLE` | The registry cannot answer. Checks fail open; reports retry with backoff.                                                   |

Full table: https://docs.omnifence.ai/registry/errors

## Before you finish

Confirm each item with the user:

- The hashing test passes every vector.
- No plaintext email reaches a registry request or a log line on the registry path.
- A check failure never blocks a sign-up, and a re-check is queued.
- No automated path sends a report. Every report comes from a human ban decision.
- Every unban path revokes the stored `entry_id`.
- Nothing in the moderation integration, if one exists, calls the registry.
