# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

First build (SOL-38): https://linear.app/sol-software/issue/SOL-38. Design: `sol-brain/sol-gate/` (Obsidian vault), especially `01-overview`, `02-architecture`, `decisions/decision-form-is-the-front-door`, `decisions/decision-dumb-internal-services` and `decisions/decision-workflows-for-submissions`. The worked example every piece is tested against is `sol-brain/sol-api/03-scenario-form-01.md` (`tests/unit/fixtures/form-01.ts`).

## Role

**The front door** for client websites, and the only code in the stack that handles untrusted input. Every request is a form submission, sent **server-to-server** with a **per-form key**: a client's Next.js site posts its form to its own server (Server Action / Route Handler), which calls Sol Gate. Browsers never call Sol Gate directly — a key in browser code would be public. The caller supplies **only content** (`fields`); which integrations run, who is notified and what the notification says all come from the form's configuration in sol-api. Behind it, **sol-integrate** (Mailchimp; Sheets is SOL-10) and **sol-notify** (email; Slack is SOL-13) are internal-only and trust what Sol Gate sends them.

## Commands

```bash
npm run dev        # wrangler dev on http://localhost:8790 — bindings connect to sol-api / sol-integrate / sol-notify's own `wrangler dev` sessions
npm test           # unit tests, vitest via @cloudflare/vitest-pool-workers
npm run type-check # tsc --noEmit
npm run deploy     # deploy to Cloudflare Workers
```

## Endpoint

```
POST /v1/clients/:clientId/forms/:formId/submissions
X-API-Key: sgk_…   (a key of this form, created in sol-api)
{ "fields": { "firstName": "Jane", "email": "jane@example.com", … } }

→ 202 { "success": true, "data": { "submissionId": "<uuid>" } }
```

Checked in this order:

| Step | Failure |
|---|---|
| `X-API-Key` is a key of **this form** (`lib/form-key.ts`): missing or not `sgk_…` → rejected without a sol-api call; otherwise `POST /v1/clients/:clientId/forms/:formId/api-keys/verify` in sol-api (SOL-42) | `401` · `503` if sol-api can't verify |
| Rate limit: per form (60/min), Cloudflare rate-limiting binding | `429` + `Retry-After: 60` |
| Load the form: `GET /v1/clients/:clientId/forms/:formId` (sol-api, client-scoped) | `404` unknown form / wrong client · `503` sol-api unreachable |
| Body ≤ 64 KB, JSON, `{ fields: object }` | `413` · `422` |
| `fields` against `forms.payload_schema` (JSON Schema 2020-12, `@cfworker/json-schema` — Ajv can't run on Workers) | `422` with `details: [{ path, message }]` |

**No Turnstile, Origin check, CORS or per-IP limit** (decided 2026-09-28, see `sol-brain/sol-gate/decisions/decision-api-key-not-turnstile`; per-form keys since 2026-09-29): callers are servers, so there's no browser to run Turnstile, a server's `Origin` header proves nothing, and the only IP Sol Gate sees is the calling server's. `forms.allowed_origins` is currently unused. The key is checked **before** the rate limit, so requests without a valid key can't use up a form's quota and block its real submissions. Bot protection for a public web form is the calling site's job (e.g. a honeypot or rate limit in the Next.js route). Anything else in the body (recipients, templates…) is ignored — Sol Gate *builds* each internal request from configuration, it never forwards the caller's.

## After the 202: a Cloudflare Workflow per submission

`SUBMISSION_WORKFLOW.create({ id: submissionId, params })` — params hold a snapshot of the form (integrations, channels, schema) and the validated fields, so processing never reloads config mid-flight. The workflow class (`src/workflows/submission.ts`) is a thin wrapper around `services/process-submission.ts`, which is written against a narrow `Step` interface so it's unit-tested with a fake step.

1. **Integrations, in parallel** — one step each (`integration <id>`). `services/integration-mapping.ts` maps fields with `field_mapping`; a mapping that can't produce a write (no email submitted, invalid mapping, Google Sheets before SOL-10, unknown type) is `skipped` without calling sol-integrate. sol-integrate returns `{ outcome, url, detail }` with `200` for every outcome; the step only retries (2×, 10 s exponential) when sol-integrate is unreachable or 5xx. A 4xx is `failed` immediately. Exhausted retries → `failed` ("Couldn't reach the integration service"), never a thrown workflow.
2. **Resolve channels** — one step, one call: `GET /v1/clients/:clientId/channels?ids=…`. Only `{ id, type, emailAddresses }` is kept: the response also carries Slack webhook URLs, which must never be persisted in workflow state or forwarded.
3. **Notify every channel, always** — whether integrations succeeded or failed — one step each (`notify <channelId>`). Built by `services/notifications.ts`:
   - **Email:** `form_submission` (or the row's `template`), `subject` (fallback `New submission: <form name>`), fields filtered by `includeFields` (NULL = all submitted, `[]` = none), integration results for **only** that channel's `integrationIds` (opt-in: empty = none, not all) in the form's integration order, and a `Reply to {name}` `mailto:` `cta` when the form has an email field (schema `format: "email"`, else a field named like `email`).
   - **Slack:** the row's fixed `message` + `slackChannelId` (= `channels.id`). Never the webhook.
   - Every request: `context: { formId, submissionId }`, `idempotencyKey: submissionId:channelId`.
   - A 4xx from sol-notify is recorded as `failed` and not retried; 5xx/unreachable retries 3×.

A step that already succeeded is never re-run, so a retry can't write to Mailchimp twice or re-send an email. Code outside `step.do()` re-runs whenever the instance resumes — keep it deterministic (no I/O, no randomness, no `Date.now()`). Step names must stay unique and stable per instance. The workflow's output is a summary (`integrations[].outcome`, `notifications[].status`) with no field values; one `submission processed` log line carries it.

### Ahead of sol-notify (as of its v1.2.0)

- `form_submission` template → SOL-34. Until then sol-notify 422s these emails; they're logged as `failed`.
- `type: "slack"` → SOL-13. Same.
- `context` / `idempotencyKey` → SOL-37. Silently dropped by sol-notify's schema until then — harmless, but sol-notify can't dedupe a retried notification yet. **SOL-37 must land before real traffic** (it also makes sol-notify internal-only).

## Environments

`ENVIRONMENT` must be one of `development | preview | staging | production` (`src/lib/environment.ts`, same as the siblings); anything else 500s every request, including `/health`.

| ENVIRONMENT | Worker | `SOL_API` / `SOL_INTEGRATE` / `SOL_NOTIFY` bindings | Workflow | Public URL |
|---|---|---|---|---|
| `development` | local `npm run dev` (:8790) | `sol-api` / `sol-integrate` / `sol-notify` (their local `wrangler dev` sessions) | `sol-gate-submission-dev` (local) | localhost |
| `staging` | `sol-gate-staging` | `sol-api-staging` / `sol-integrate-staging` / `sol-notify-staging` | `sol-gate-submission-staging` | workers.dev |
| `production` | `sol-gate` | `sol-api` / `sol-integrate` / `sol-notify` | `sol-gate-submission` | workers.dev (custom domain later) |

No `preview` env yet — per-PR previews + e2e are a follow-up (sol-integrate's SOL-20 pattern). Bindings, rate limiters and workflows **aren't inherited** by `[env.*]` blocks: each declares its own, and each env has its own rate-limit `namespace_id`s.

Staging deploys from `.github/workflows/release.yml` on every merge to `main`; production is the same workflow's `deploy-production` job, gated behind the `production` GitHub Environment.

**GitHub secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RELEASE_TOKEN`, and per env (`_STAGING` / `_PRODUCTION`): `SOL_API_KEY_*` (sol-api's key), `SOL_INTEGRATE_API_KEY_*` (= sol-integrate's `API_KEY_*`), `SOL_NOTIFY_API_KEY_*` (= sol-notify's `API_KEY_*`). Sol Gate holds **no inbound key**: callers use per-form keys stored (as SHA-256 hashes) and verified in sol-api.

**Form keys** are managed in sol-api (Bruno → Forms): `POST /v1/clients/:clientId/forms/:formId/api-keys` `{ name }` returns the `sgk_…` key **once**; `GET …/api-keys` lists them (no key material); `DELETE …/api-keys/:keyId` revokes. A form can have several keys, so rotation is create → deploy to the site → revoke the old one. In Next.js, keep the key in a server-only env var (never `NEXT_PUBLIC_…`).

Local secrets go in `.dev.vars` (gitignored, see `.dev.vars.example`).

## Architecture

**Stack:** Hono 4.x → Cloudflare Workers + Workflows, Zod, `@cfworker/json-schema`, no database. Scaffolded from sol-integrate — same logger (key/token redaction), response envelope, `ENVIRONMENT` enum and release pipeline.

```
src/
├── index.ts                       # Hono app; validates ENVIRONMENT; exports SubmissionWorkflow
├── routes/
│   ├── health.ts                  # GET /health
│   └── submissions.ts             # POST /v1/clients/:clientId/forms/:formId/submissions — the request flow only
├── validators/submission.ts       # body schema + parseSubmissionBody() (size 413, JSON / shape 422)
├── workflows/submission.ts        # WorkflowEntrypoint → processSubmission()
├── services/
│   ├── process-submission.ts      # integrations → resolve channels → notifications, as durable steps
│   ├── integration-mapping.ts     # field_mapping → sol-integrate fields, per integration type
│   └── notifications.ts           # one channel's notification (pure)
├── lib/
│   ├── service-fetch.ts           # binding fetch: timeout, text-first parse, ServiceError.permanent
│   ├── sol-api.ts / sol-integrate.ts / sol-notify.ts   # typed clients
│   ├── form-key.ts                # checkFormKey(): the caller's key, verified by sol-api
│   ├── form-lookup.ts             # lookUpForm(): rate limit → load form
│   ├── rate-limit.ts              # isRateLimited(): per-form binding
│   ├── payload-schema.ts          # JSON Schema validation, displayValue()
│   ├── environment.ts, logger.ts, responses.ts
├── middleware/error.ts            # global error envelope
└── types/index.ts                 # Env bindings, AppEnv, ErrorCode
tests/unit/                        # Workers pool; fixtures/form-01.ts is the Form 01 scenario
```

## Gotchas

- **vitest-pool-workers 0.5 can't run Workflows** and refuses to start with the `SUBMISSION_WORKFLOW` binding, so `vitest.config.ts` doesn't load `wrangler.toml` (compat date/flags are duplicated there — keep them in sync). Tests pass their own env to `app.request()`.
- A plain `fetch()` between Workers on the same `workers.dev` subdomain fails with `error code: 1042` — always go through the bindings.
- Rate limiting is per Cloudflare location and eventually consistent: a cap on abuse, not an exact quota. `period` must be 10 or 60.
- Workflow params and step outputs hold the submission (PII) for the instance's retention period. Instance retention isn't set explicitly yet.
- Logs never carry field values — only IDs, counts and outcomes. The logger redacts any field whose **name** contains `key`, `token`, `secret`… — so the matched form key's id is logged as `credentialId`, not `keyId`.

## Related

- sol-api: `GET /v1/clients/:clientId/forms/:formId`, `GET /v1/clients/:clientId/channels?ids=` (SOL-36).
- sol-integrate: `POST /` (SOL-9/33); SOL-10 adds Google Sheets — its append isn't idempotent, which the step-per-integration design already protects against at Sol Gate's level.
- sol-notify: SOL-34 (`form_submission`), SOL-13 (Slack), SOL-37 (internal-only, idempotency, `context`).
