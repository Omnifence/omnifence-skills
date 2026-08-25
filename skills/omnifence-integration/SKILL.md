---
name: omnifence-integration
description: >-
  Integrate the Omnifence content moderation API into a codebase. Use when the user asks to
  "add moderation", "integrate Omnifence", "add content moderation", "moderate generated
  content", or wants prompts, images, video, audio, or AI-character chat checked before it
  reaches end users. Finds generation call sites (third-party APIs or in-house platforms),
  confirms them with the user, then wires POST /api/v1/moderate/{text,image,video,audio}
  with async job handling.
---

# Omnifence integration

Omnifence is a content moderation API for AI-generated media. A client submits text, an
image URL, a video URL, or an audio URL; a moderation pipeline classifies it; the client
receives a pass/reject decision as an asynchronous job result.

Your task: find every place this codebase generates content, confirm the list with the
user, and insert a moderation step at each confirmed site.

Base URL: `https://api.omnifence.ai`. Auth: `Authorization: Bearer <API key>` on every
request. There is no SDK — use plain HTTP (`fetch` examples in `references/`).

## Step 1 — Find the generation call sites

Scan the codebase for every place content is generated, of any provenance. Do not stop at
known SDKs.

**Known external providers.** Search for clients, SDK imports, and REST calls to:
OpenAI-compatible image/chat APIs, OpenRouter, Replicate, fal.ai, RunPod, ComfyUI,
Stability AI, ElevenLabs — and any generic chat-completion loop that powers an AI
character.

**In-house generation platforms.** The customer may run their own inference services,
self-hosted model servers, or internal microservices. These have no recognisable SDK, so
search for behavioural signals instead:

- Request payloads that carry a prompt, negative prompt, seed, or model/checkpoint name.
- Queue or job submissions whose results are images, video, or audio.
- GPU-worker callbacks or polling loops that collect a generated file.
- Uploads of freshly generated files to object storage (S3, GCS, R2).
- Streaming chat loops that produce assistant/character replies.

Classify each site by what it **consumes** (a user-written prompt, a chat turn) and what
it **produces** (image, video, audio, text reply). One site can need two moderation
steps: the prompt before generation, and the output after.

## Step 2 — Discovery checkpoint (required)

**Hard rule: write no integration code until the user approves the call-site list.**

The scan is heuristic. In-house platforms are easy to miss, and a missed call site is
unmoderated content reaching end users. Before any edit, present the discovered sites as
a list — one row per site:

```
file.ts:123 — <what it generates or consumes> — <which endpoint applies>
```

Ask the user to confirm the list, remove wrong entries, and add sites the scan missed.
Ask specifically whether any in-house generation path exists that the scan did not find.
Only after the user approves do you write code, and only for the approved sites.

## Step 3 — Map each site to an endpoint

| Call site | Endpoint | Field |
| --- | --- | --- |
| User-written generation prompt (moderate **before** the generation call) | `POST /api/v1/moderate/text` | `text` |
| AI-character chat turn — the user message, and optionally the model reply | `POST /api/v1/moderate/text` | `text` |
| Generated image | `POST /api/v1/moderate/image` | `image` (publicly reachable HTTPS URL, ≤ 10 MB) |
| Generated video | `POST /api/v1/moderate/video` | `video` (publicly reachable HTTPS URL, ≤ 300 MB) |
| Generated audio | `POST /api/v1/moderate/audio` | `audio` (publicly reachable HTTPS URL, ≤ 100 MB, ≤ 30 minutes) |

There is **no dedicated chat endpoint**: moderate each chat turn as plain text through
`/api/v1/moderate/text`. Media endpoints take a URL, not a file body — the media must be
at a URL the Omnifence classifiers can fetch (a public bucket URL or a presigned URL
works; a private or internal network address is rejected with `400 INVALID_REQUEST`).

All submissions are `multipart/form-data`. Every submission accepts an optional
`webhook_url` field that overrides the account's global webhook for that job.

Per-endpoint request/response examples: `references/moderate-text.md`,
`references/moderate-image.md`, `references/moderate-video.md`,
`references/moderate-audio.md`.

## Step 4 — Handle the async contract

Every submission returns `202` with a job ID, not a decision:

```json
{ "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890", "status": "queued" }
```

The decision arrives later, one of two ways:

1. **Webhook (preferred).** Register a global URL via `POST /api/v1/webhook/register`, or
   pass `webhook_url` per request. Omnifence POSTs the result to it on completion and
   retries failed deliveries for hours. See `references/webhook-handler.md`.
2. **Polling.** Poll `GET /api/v1/jobs?status=queued,processing` (one request covers all
   outstanding jobs) or `GET /api/v1/job/{id}`. Pace polling on the `x-ratelimit-limit`,
   `x-ratelimit-remaining`, and `x-ratelimit-reset` response headers, and honour
   `retry-after` on a `429` — never guess the limit. See `references/polling.md`.

**Fail closed.** Hold the prompt, chat turn, or generated media in a pending state until
a `pass` decision arrives. Do not show content to end users while its job is `queued` or
`processing`, and do not treat a failed job, a timeout, or an API error as a pass. Store
the `job_id` next to the content so the decision can be matched back to it.

## Step 5 — Handle the decision

A completed job carries:

- `is_prohibited` — `true` = rejected, `false` = passed, `null` while still pending.
- `reason` — present only on a rejection; names the policy or custom category that
  tripped.
- `nsfw` — informational label on image/video jobs when the NSFW check is enabled; it
  never causes a rejection on its own.

**Rejection reasons are for the operator, not for end users.** Log the `reason` and show
it in internal admin tooling; show end users only a generic "this content was not
allowed" message. Reasons can describe policy violations in terms unsuitable for an
end-user screen.

Scopes: each endpoint requires its scope — `moderate:text`, `moderate:image`,
`moderate:video`, `moderate:audio`; reading a job requires `job:read`. A missing scope
returns `403 FORBIDDEN`.

Error handling: `400 INVALID_REQUEST` (bad field or unreachable URL), `401 UNAUTHORIZED`
(bad key), `402 PAYMENT_REQUIRED` (account out of credit), `429 RATE_LIMITED` (back off
per `retry-after`), `500`/`503` (retry with backoff). Errors are JSON:
`{ "error": "CODE", "message": "...", "statusCode": 400 }`. On any error the content
stays held — fail closed.

## Step 6 — Agent guardrails

- **Show the diff.** Present every change per approved call site; keep changes minimal
  and in the codebase's existing style.
- **Add tests** around each interception point: prompt rejected → generation not called;
  media rejected → not published; API error → content stays held; pass → content
  released.
- **Never touch `/api/v1/admin/*`.** Those routes are for Omnifence operators, not for
  integrations. Do not call them, document them, or store credentials for them.
- **Never log or commit the API key.** Read it from an environment variable (for example
  `OMNIFENCE_API_KEY`), never hard-code it, and keep it out of client-side/browser code —
  moderation calls belong on the server.
