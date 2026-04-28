# CLAUDE.md — LILA (Lending Intelligence and Loan Automation)

This file is the canonical reference for Claude Code (and any AI assistant) working inside the LILA repository. It captures product intent, technical decisions, conventions, and guardrails. Treat every rule here as binding unless a human reviewer explicitly overrides it in a PR discussion.

---

## 1. Product Overview

**LILA** (Lending Intelligence and Loan Automation) is the operating platform for **Junto**, a short-term lending business. LILA powers the full loan lifecycle: origination, KYC/underwriting, disbursement tracking, repayment, collections, portfolio analytics, and partner integrations.

### Primary users
- **Borrowers** — apply for loans, sign documents, track repayments. Web and WhatsApp.
- **Loan officers / agents** — review applications, approve/reject, manage portfolios. Web only.
- **Admins / risk team** — configure products, set risk rules, run reports, manage users. Web only.
- **Third-party partners** — programmatic access via the public API (e.g., embedded lending, broker referrals, accounting systems).

### Product principles
1. **Click economy**: every workflow is benchmarked against the smallest number of clicks/taps that accomplishes the goal. If a flow takes more than three clicks for a frequent task, it must be questioned.
2. **Mobile-first parity**: every borrower-facing screen ships mobile-first; every operator screen ships responsive desktop-first but must remain usable on tablet.
3. **Predictable latency**: P95 page load under 1.5s on 4G, P95 API response under 300ms for read endpoints.
4. **Explainable decisions**: any automated lending decision must record the inputs, rules, and version that produced it.
5. **Auditable by default**: every state change writes to an append-only audit log.

---

## 2. Tech Stack (authoritative)

| Layer | Choice | Notes |
|---|---|---|
| Framework | **Next.js 16 (App Router, Turbopack)** | Server Components by default, Client Components only where needed. Turbopack is the default dev + build engine. |
| Runtime | **React 19** | Server Actions, `useActionState`, async components are stable. |
| Language | **TypeScript** | `strict: true`, no `any` without `// @ts-expect-error` justification |
| Styling | **Tailwind CSS 4** | CSS-first config: design tokens live in `app/globals.css` under `@theme` — see §6. **No `tailwind.config.ts`.** |
| Auth proxy | **`proxy.ts`** | Next 16 renamed `middleware.ts` → `proxy.ts`; the convention name is "proxy" but it's the same edge runtime. |
| Database | **Supabase (PostgreSQL)** | Row Level Security (RLS) on every table |
| Auth (users) | **Supabase Auth** | Email/password + Google OAuth |
| Auth (admin) | **HMAC-signed cookies** | Separate session domain; see §5 |
| Hosting | **Vercel** | Production on `main`, preview on every PR |
| Email | **Resend.io** | Transactional only; templates in `/emails` (React Email) |
| Storage | **Supabase Storage** | Signed URLs, never public buckets for borrower documents |
| Cron | **Vercel Cron** | Definitions in `vercel.json` |
| Alerts | **Slack webhook** | One channel per environment; see §11 |
| Messaging (client) | **WhatsApp Business API** | Outbound notifications + inbound conversational flows |
| Observability | Vercel Analytics + Sentry | Sentry for errors, Vercel for web vitals |

**Do not introduce new dependencies without explicit approval.** If a task seems to require a new package, propose it in the PR description and wait for confirmation.

---

## 3. Repository Structure

```
/
├── app/                          # Next.js App Router
│   ├── (marketing)/              # Public marketing site
│   ├── (auth)/                   # Login, signup, password reset
│   ├── (borrower)/               # Authenticated borrower portal
│   ├── (admin)/                  # Admin / operator console (HMAC-protected)
│   ├── api/                      # Internal API routes (BFF pattern)
│   │   ├── v1/                   # Public, versioned, third-party API
│   │   ├── webhooks/             # Inbound webhooks (Stripe, WhatsApp, etc.)
│   │   └── cron/                 # Vercel Cron handlers
│   └── layout.tsx
├── components/
│   ├── ui/                       # Primitive components (Button, Input, ...)
│   ├── patterns/                 # Composed patterns (DataTable, FormSection, ...)
│   └── features/                 # Feature-specific components, colocated when possible
├── lib/
│   ├── supabase/                 # Server + browser clients, typed helpers
│   ├── auth/                     # HMAC cookie utilities, RBAC helpers
│   ├── api/                      # Public API utilities (rate limit, auth, schemas)
│   ├── lending/                  # Domain logic: pricing, schedules, risk rules
│   ├── notifications/            # Email (Resend), WhatsApp, Slack adapters
│   └── utils/
├── emails/                       # React Email templates
├── db/
│   ├── migrations/               # SQL migrations (Supabase CLI)
│   ├── seed/                     # Seed scripts for local + staging
│   └── policies/                 # RLS policies, one file per table
├── public/                       # Static assets
├── docs/
│   ├── api/                      # OpenAPI spec, partner integration guide
│   ├── adr/                      # Architecture Decision Records
│   └── runbooks/                 # On-call runbooks
├── scripts/                      # Local dev / ops scripts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/                      # Playwright
├── tailwind.config.ts
├── vercel.json
├── package.json
└── CLAUDE.md
```

---

## 4. Coding Conventions

### TypeScript
- `strict` mode is non-negotiable. No `any`. Prefer `unknown` and narrow.
- Domain types live in `lib/<domain>/types.ts`. Database types are generated from Supabase: `pnpm db:types`.
- Never re-derive a type that the database already exports. Import from `lib/supabase/types.ts`.
- Branded types for IDs: `type LoanId = string & { __brand: 'LoanId' }`. Prevents passing a `UserId` where a `LoanId` is expected.

### React / Next.js
- **Server Components by default.** Add `'use client'` only when you need state, effects, or browser APIs.
- Data fetching happens in Server Components or Route Handlers, never in Client Components via `useEffect` for first paint.
- Use **Server Actions** for mutations from forms; validate input with **Zod** before touching the database.
- Loading and error UI: every route segment has `loading.tsx` and `error.tsx`.
- Streaming with `<Suspense>` for slow data; never block the shell on a slow query.

### File naming
- Components: `PascalCase.tsx`. One component per file unless tightly coupled.
- Utilities: `kebab-case.ts`.
- Tests: colocated as `Foo.test.ts` or under `tests/` mirroring the source path.

### Imports
- Absolute imports via `@/` alias. No `../../../` chains.
- Order: external → `@/lib` → `@/components` → relative → styles. Enforced by ESLint.

### Errors
- Throw typed errors from `lib/errors.ts` (`AuthError`, `ValidationError`, `NotFoundError`, `ConflictError`, `RateLimitError`).
- API routes map errors to HTTP via `lib/api/error-handler.ts`. Never leak stack traces to clients.
- Log to Sentry with breadcrumbs. PII goes through `lib/utils/redact.ts` first.

### Comments
- Comment **why**, not **what**. The code already says what. If a regulation, edge case, or non-obvious decision is at play, leave a comment.
- Every non-trivial domain function has a JSDoc block describing inputs, outputs, and side effects.

---

## 5. Authentication & Authorization

LILA has **two distinct identity domains** that must never share a session:

### 5.1 User auth — Supabase Auth
- Used for **borrowers** and **agents/loan officers** (anyone who applies, signs, or services loans).
- Methods: email/password and **Google OAuth**.
- Sessions managed by Supabase SSR helpers (`@supabase/ssr`). Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`.
- All borrower-facing tables enforce **Row Level Security**. Default-deny policies; explicit grants per role.
- Roles are stored in `user_profiles.role` and mirrored into JWT claims via a Supabase trigger so RLS can read them without an extra query.

### 5.2 Admin auth — HMAC-signed cookies
- Used for the **internal admin console** (`/admin/*`). Lives on a separate cookie name and path.
- Login flow: admin authenticates via Supabase Auth + a hardware key / TOTP step, the server then issues an **HMAC-signed cookie** (`lila_admin_sid`) containing `{ adminId, issuedAt, expiresAt, scope }` signed with `ADMIN_COOKIE_SECRET` (rotated quarterly).
- Cookie is verified by `middleware.ts` for every `/admin/*` and `/api/admin/*` request.
- Short TTL (60 minutes idle, 8 hours absolute). Sliding refresh on activity.
- Admin actions are double-logged: Supabase audit table + Slack alert for sensitive operations (loan approval, manual payout, user role change).

### 5.3 Public API auth — see §7

### 5.4 RBAC helpers
- `requireUser(role?)` — server-side guard for borrower/agent routes.
- `requireAdmin(scope?)` — server-side guard for admin routes; checks HMAC cookie and scope claim.
- `requireApiKey(scope?)` — server-side guard for `/api/v1/*`.
- Never check roles inline in components. Always go through a guard helper so the policy is centralized.

---

## 6. Design System & UI/UX

### 6.1 Look and feel (2026 dark-first)
- **Dark mode is the default**, light mode is opt-in via system preference. Every component must render correctly in both.
- Style direction inspired by 2026 best practices: low-chroma neutrals, single accent color, generous spacing, micro-typography that earns hierarchy without bold/decoration spam, motion that signals state changes (never decorative).
- **Glass / depth** used sparingly: a single elevated surface tier for modals and command palettes. No stacked translucency.
- **Density modes**: comfortable (default for borrowers) and compact (default for operators). Toggle persisted per user.

### 6.2 Typography
- **Body**: `Inter` (variable), loaded via `next/font/google` with `display: 'swap'`.
- **Headings**: `Syne` (variable), loaded via `next/font/google` with `display: 'swap'`.
- Tailwind: `font-sans` → Inter, `font-display` → Syne.
- Type scale: 12 / 14 / 16 / 18 / 20 / 24 / 32 / 48. Line-height ratios 1.5 (body), 1.2 (display).
- No font weight below 400 for body text. Headings use 500–700.

### 6.3 Design tokens — `app/globals.css`
All colors, spacing, radii, and shadows are tokens. **Never hard-code a hex value in a component.** If you need a color that isn't in the config, propose it as a token first.

Tailwind 4 is CSS-first: tokens live in `app/globals.css` under an `@theme` block. Each `--color-*`, `--font-*`, `--radius-*`, `--shadow-*`, `--spacing-*` declaration generates a corresponding utility class (e.g. `--color-brand-500` → `bg-brand-500`, `text-brand-500`, `border-brand-500`). Dark mode uses the `.dark` class via `@variant dark`.

```css
/* app/globals.css (illustrative — keep in sync with the actual file) */
@import "tailwindcss";

@variant dark (&:where(.dark, .dark *));

@theme {
  /* Brand */
  --color-brand-50:  #eef4ff;
  --color-brand-500: #4f6bff; /* primary accent */
  --color-brand-600: #3d55e0;
  --color-brand-900: #1a2266;

  /* Semantic */
  --color-success: #22c55e;
  --color-success-subtle: #0f2a1a;
  --color-warning: #f59e0b;
  --color-warning-subtle: #2a1f0a;
  --color-danger:  #ef4444;
  --color-danger-subtle:  #2a1212;
  --color-info:    #3b82f6;
  --color-info-subtle:    #0f1e2a;

  /* Neutrals — dark-first */
  --color-bg-base:    #0a0b0f; /* app background */
  --color-bg-surface: #11131a; /* cards */
  --color-bg-raised:  #171a24; /* modals, popovers */
  --color-bg-inset:   #070810; /* input backgrounds */

  --color-border-subtle: #1f2330;
  --color-border:        #2a2f40;
  --color-border-strong: #3a4055;

  --color-fg:         #e6e8ee;
  --color-fg-muted:   #9ba0b0;
  --color-fg-subtle:  #6b7080;
  --color-fg-inverse: #0a0b0f;

  /* Typography */
  --font-sans:    var(--font-inter), system-ui, sans-serif;
  --font-display: var(--font-syne),  system-ui, sans-serif;

  /* Radii */
  --radius-sm:  6px;
  --radius:    10px;
  --radius-lg: 14px;
  --radius-xl: 20px;
  --radius-2xl: 28px;

  /* Elevation */
  --shadow-e1: 0 1px 2px  rgba(0, 0, 0, 0.30);
  --shadow-e2: 0 4px 12px rgba(0, 0, 0, 0.35);
  --shadow-e3: 0 12px 32px rgba(0, 0, 0, 0.45);

  /* Layout rhythm (named, on top of the 4px baseline grid) */
  --spacing-gutter:  24px;
  --spacing-section: 64px;

  /* Motion */
  --ease-out-quint: cubic-bezier(0.2, 0.8, 0.2, 1);
}
```

### 6.4 Components
- Primitives in `components/ui/` follow the **Radix UI + Tailwind** pattern (unstyled accessible base + tokenized styles). No third-party design system imported wholesale.
- Every interactive component must:
  - Have a visible focus ring (`focus-visible:ring-2 ring-brand-500`).
  - Be keyboard-operable (Tab, Enter, Esc, Arrow where relevant).
  - Hit a 44×44 px touch target on mobile.
  - Pass WCAG AA contrast in both themes.

### 6.5 Click economy patterns
- **Command palette** (`Cmd/Ctrl+K`) on every authenticated screen — global search, navigation, and bulk actions.
- **Inline editing** for tabular data; no modal-then-form-then-save dance for single-field changes.
- **Optimistic updates** with rollback on failure for any mutation that's safe to revert.
- **Bulk actions** on every list view (multi-select + action bar).
- **Saved views and filters** persisted per user.
- **Smart defaults**: pre-fill from prior application, last-used product, last-used branch.

### 6.6 Motion
- Durations: 120ms (micro), 200ms (default), 320ms (page-level). Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Respect `prefers-reduced-motion` — disable all non-essential motion.

### 6.7 Mobile
- Breakpoints: `sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536`.
- Borrower flows tested at 360×640 baseline.
- Bottom-sheet pattern for mobile dialogs, not centered modals.
- Sticky primary action on long forms.

---

## 7. Public API (third-party integrations)

The public API is a **first-class product**, not an afterthought. Treat any change to `/api/v1/*` as a breaking-change candidate.

### 7.1 Conventions
- **Versioned URL**: `/api/v1/...`. Breaking changes require `/v2`. Never break `/v1`.
- **REST + JSON**. Resource URLs are nouns (`/loans`, `/applications`, `/borrowers`). Verbs only for non-CRUD actions (`/loans/{id}:disburse`).
- **Pagination**: cursor-based (`?cursor=...&limit=...`, max limit 100). Response includes `next_cursor` and `has_more`.
- **Filtering**: query params with explicit operators (`status=approved`, `created_after=2026-01-01`).
- **Idempotency**: every POST accepts `Idempotency-Key` header (UUID). Stored 24h.
- **Timestamps**: ISO 8601 UTC, always.
- **Money**: stored and returned as `{ amount: integer (minor units), currency: ISO-4217 }`. Never floats.
- **Errors**: `{ error: { code, message, details?, request_id } }`. Stable `code` strings.

### 7.2 Authentication
- API keys issued per partner from the admin console. Format: `lila_live_<32 chars>` (or `lila_test_*`).
- Sent as `Authorization: Bearer <key>`.
- Each key has scopes (`loans:read`, `loans:write`, `borrowers:read`, ...). Principle of least privilege.
- Keys are hashed at rest (Argon2id). Display the plaintext **once**, at creation.
- Rate limits per key: default 60 req/min, burst 120. Configurable per partner. Returned via `X-RateLimit-*` headers.
- All API requests are logged with `request_id`, key id, endpoint, status, latency.

### 7.3 Webhooks
- Partners can subscribe to events: `loan.created`, `loan.approved`, `loan.disbursed`, `repayment.received`, `repayment.failed`, `borrower.kyc_completed`, ...
- Signed with HMAC-SHA256, header `X-LILA-Signature: t=<unix>,v1=<hmac>`. Same scheme as Stripe so partners can reuse libraries.
- Retries with exponential backoff up to 24h. Dead-letter after that with Slack alert.

### 7.4 Documentation
- **OpenAPI 3.1 spec** is the source of truth at `docs/api/openapi.yaml`. Generated docs published to `/docs` (Stoplight Elements or Scalar).
- Every endpoint must include: summary, description, request schema, response schema, error responses, at least one example request and response, and a code sample (curl + TypeScript).
- A **Partner Integration Guide** at `docs/api/partner-guide.md` covers: authentication, sandbox, webhooks, common workflows, rate limits, changelog.
- A **changelog** at `docs/api/CHANGELOG.md` is updated on every API change. Include date, version, additive/breaking flag.
- Postman/Insomnia collections regenerated from OpenAPI on each release.

### 7.5 Versioning policy
- Additive changes (new endpoints, new optional fields, new enum values flagged) are **non-breaking** and ship to `v1`.
- Removing fields, changing types, changing required-ness, or changing default behavior is **breaking** and requires a new major version.
- Deprecations announced 90 days before removal. Returned in `Deprecation` and `Sunset` HTTP headers.

---

## 8. Data Layer (Supabase / PostgreSQL)

### 8.1 Migrations
- Every schema change is a SQL migration in `db/migrations/`, named `YYYYMMDDHHMM_short_description.sql`.
- Migrations are **forward-only**. To revert, write a new migration.
- Apply via `supabase db push` in CI; never edit the schema in the dashboard for tracked environments.

### 8.2 RLS
- **Every table has RLS enabled.** No exceptions. A migration that creates a table without RLS fails review.
- Policies live in `db/policies/<table>.sql`, one file per table, easy to diff.
- Service-role key is used **only** in server code, never exposed to the browser or to API consumers.

### 8.3 Schema conventions
- `id uuid primary key default gen_random_uuid()`.
- `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` with trigger.
- Soft-delete via `deleted_at timestamptz` only where regulatory retention requires it; otherwise hard delete.
- Money columns: `amount_minor bigint`, `currency char(3)`. No `numeric` for money on hot paths.
- Enums: PostgreSQL `enum` types, named `<table>_<field>_enum`.
- Foreign keys always `on delete restrict` unless cascade is explicitly justified in the migration comment.

### 8.4 Audit log
- Append-only `audit_events` table: `id, actor_type, actor_id, action, resource_type, resource_id, before, after, request_id, created_at`.
- Every state-changing server action and admin action writes one row.

---

## 9. Notifications

### 9.1 Email — Resend
- Templates in `/emails` using **React Email**. Preview locally with `pnpm email:dev`.
- Every transactional email includes: clear sender (`Junto <noreply@junto.app>`), reply-to address, plain-text fallback, unsubscribe link where legally required.
- Triggered via `lib/notifications/email.ts`. Never call Resend directly from a route handler — go through the helper so logging and retries are uniform.
- Bounces and complaints are processed via Resend webhook into `email_events`.

### 9.2 WhatsApp
- Outbound: template messages for transactional events (application received, approved, payment due, payment received, late notice).
- Inbound: conversational flow for status checks, payment links, document upload. Sessions are stateful in Postgres.
- All templates are versioned and approved in WhatsApp Business Manager. Code references templates by stable name, not by ID.
- All messages logged in `whatsapp_events` with direction, template, status.

### 9.3 Slack alerts
- One webhook per environment (`SLACK_WEBHOOK_URL_PROD`, `_STAGING`, `_DEV`).
- Channels: `#lila-alerts-prod`, `#lila-alerts-staging`. Wired through `lib/notifications/slack.ts`.
- Trigger conditions:
  - Any `5xx` rate above threshold.
  - Cron job failure.
  - Webhook delivery failure (after retries exhausted).
  - Sensitive admin action (loan approval over threshold, role change, manual payout, key rotation).
  - Failed background job after retries.
- Messages use Block Kit, include environment, request id, link to Sentry/log, and a summary.

---

## 10. Cron & Background Jobs

- **Vercel Cron** is the only scheduler. Definitions in `vercel.json` under `crons`.
- Each cron handler lives at `app/api/cron/<name>/route.ts`, protected by a `CRON_SECRET` header check (`x-vercel-cron` + shared secret).
- Handlers are **idempotent**: running the same job twice in the same minute must not double-charge, double-send, or double-mark.
- Long jobs offload to a queue (Supabase + `pg_cron` worker pattern, or Inngest if approved). A cron handler should return within 60s.
- Standard jobs:
  - `daily-late-fee-assessment` — evaluate overdue loans, assess fees, send WhatsApp notice.
  - `daily-repayment-reminders` — T-3, T-1, T+0 borrower reminders.
  - `hourly-webhook-retry` — retry failed outbound webhooks.
  - `nightly-portfolio-snapshot` — write daily aggregates for analytics.

---

## 11. Environments & Secrets

| Env | Branch | URL | DB | Notes |
|---|---|---|---|---|
| Production | `main` | `app.junto.com` | prod project | Manual promote required |
| Staging | `staging` | `staging.junto.com` | staging project | Auto-deploy on merge |
| Preview | any PR | `*.vercel.app` | staging DB (read-only seed) | Per-PR |
| Local | — | `localhost:3000` | local Supabase | `pnpm dev` |

### Required environment variables
```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # server only
# Admin auth
ADMIN_COOKIE_SECRET=              # 64-byte random, rotated quarterly
# Email
RESEND_API_KEY=
EMAIL_FROM="Junto <noreply@junto.app>"
# WhatsApp
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_TOKEN=
WHATSAPP_VERIFY_TOKEN=
# Slack
SLACK_WEBHOOK_URL=
# Cron
CRON_SECRET=
# Public API
API_KEY_HASH_PEPPER=
# OAuth
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
# Misc
SENTRY_DSN=
NEXT_PUBLIC_SENTRY_DSN=
```

Secrets are managed in Vercel + 1Password. Never commit. Never log. `.env.local` is git-ignored.

---

## 12. Testing & Quality

- **Unit tests**: Vitest. Pure functions in `lib/` must be ≥ 90% covered.
- **Integration tests**: Vitest + Supabase local. Cover RLS policies, server actions, API routes.
- **E2E tests**: Playwright. At minimum: borrower happy-path application, agent approval flow, admin login, public API smoke.
- **Type check** (`pnpm typecheck`), **lint** (`pnpm lint`), **test** (`pnpm test`), **e2e** (`pnpm e2e`) all run in CI on every PR.
- A PR cannot merge with a failing check.
- **Accessibility**: `axe` runs in Playwright on key screens. Fail on violations of severity `serious` or above.

---

## 13. Performance

- Use **Server Components** + **streaming** for the shell.
- Cache aggressively: `revalidate` on segment data, `unstable_cache` for expensive helpers, HTTP cache headers on public API GETs (with `s-maxage` + `stale-while-revalidate`).
- Images: `next/image` only. Bucketed sizes. AVIF/WebP automatic.
- No client-side data fetching for first paint.
- Bundle budget: 180KB JS gzipped per route. CI fails if exceeded without override.
- Lighthouse perf ≥ 90 on borrower flows, ≥ 85 on operator screens.

---

## 14. Security

- **OWASP ASVS L2** target.
- Input validation with Zod on every server action and API route. Reject on first error.
- Output encoding via React; no `dangerouslySetInnerHTML` without a security review.
- CSP via `next.config.js` headers. Disallow `unsafe-inline` for scripts.
- HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy headers set globally.
- All borrower documents in private Supabase Storage buckets, accessed via short-lived signed URLs (max 5 min).
- PII at rest: column-level encryption for SSN/government ID equivalents using `pgsodium`.
- Secrets scanning + dependency audit in CI.
- Quarterly key rotation: `ADMIN_COOKIE_SECRET`, API key pepper, Supabase service role.

---

## 15. Compliance & Audit

- Every loan decision (auto or manual) writes a **decision record**: inputs (snapshot), rule version, score, outcome, decided_by, timestamp.
- Document signing uses a tamper-evident envelope (hash + timestamp + signer identity).
- Data retention configured per data class in `docs/data-retention.md`.
- DSAR (data subject access request) handled via admin tool that exports a single user's data as JSON + linked documents.

---

## 16. Working with Claude Code (rules of engagement)

When Claude is asked to make a change in this repo, it should:

1. **Plan first.** For any change touching more than one file, write a short plan in the response before editing.
2. **Read before writing.** Open the relevant files and surrounding code; do not assume structure.
3. **Stay inside the stack.** No new dependencies, no new infrastructure, no new auth schemes without explicit approval. Propose, don't add.
4. **Respect tokens.** If a hex color, font, or spacing value isn't already a Tailwind token, add the token first, then use it.
5. **Honor RLS and guards.** Never write a server action or API route without an explicit auth check at the top.
6. **Validate input.** Every server action and API route starts with a Zod schema parse.
7. **Update docs in the same PR.** API changes update `openapi.yaml` and `CHANGELOG.md`. Schema changes update the migration and the policy file.
8. **Write tests for new behavior.** At minimum, one happy-path and one failure-path test.
9. **No silent error swallowing.** Catch, classify, log, and surface.
10. **Performance check.** For any new client-side dependency or new query, note the cost in the PR description.
11. **Mobile check.** Any UI change includes a note on how it behaves at 360px and at 1440px.
12. **Accessibility check.** New interactive components include keyboard and screen-reader notes.
13. **Ask when ambiguous.** If the task could be interpreted more than one way and the choice is consequential, ask before coding.

### Commands Claude can rely on
```
pnpm dev            # local dev server
pnpm build          # production build
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm test           # vitest
pnpm e2e            # playwright
pnpm db:types       # regenerate Supabase types
pnpm db:migrate     # apply local migrations
pnpm db:reset       # reset local DB and reseed
pnpm email:dev      # React Email preview
pnpm api:docs       # render OpenAPI docs locally
```

### Things Claude must never do
- Commit secrets, even temporarily.
- Disable RLS, even "just for a test".
- Use the service-role key from a Client Component or expose it in any response.
- Hard-code colors, fonts, spacing, or copy strings instead of using tokens / i18n.
- Introduce a route under `/admin/*` without HMAC cookie verification in middleware.
- Ship an API change without updating `openapi.yaml` and `CHANGELOG.md`.
- Edit files under `db/migrations/` that have already been applied to staging or prod.

---

## 17. Glossary

- **Application** — a borrower's request for a loan, pre-approval.
- **Loan** — an approved, disbursed (or pending disbursement) credit obligation.
- **Repayment** — a single scheduled or actual payment against a loan.
- **Decision** — the recorded outcome of underwriting (approve / reject / refer).
- **Partner** — a third party with API access.
- **Operator** — internal staff (loan officer, agent, risk analyst).
- **Admin** — internal staff with elevated privileges (config, payouts, role mgmt).

---

_Last updated: 2026-04-28. Owners: Junto Engineering. Update this file in the same PR as the change it describes — stale guidance is worse than no guidance._
