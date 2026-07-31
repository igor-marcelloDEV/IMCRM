# IMCRM — architecture

A multi-tenant WhatsApp-first CRM: Next.js 16 (App Router, Turbopack) on
Vercel, Supabase (Postgres + Auth + Storage) as the backing store, with
WhatsApp (Meta Cloud API or Baileys), Instagram, and Asaas (payments +
NFS-e) as external integrations. This doc covers the pieces that don't
fit in a single file's comments: tenancy, the reliability patterns
introduced in the Sprint 0 hardening pass, and where to find everything
else.

See also: [`public-api.md`](./public-api.md) (the external `/api/v1/*`
surface for third-party integrations) and
[`automations-and-cron.md`](./automations-and-cron.md) (every recurring
background job and how to schedule it).

## Tenancy & permissions

Every tenant is an `accounts` row. A user can belong to more than one
account (`profiles.account_id` is the *current* one; membership itself
lives in `account_members`). Almost every table that holds tenant data
carries `account_id`, and Row-Level Security policies scope reads/writes
to accounts the caller belongs to — RLS is the backstop, not the only
guard.

Roles are a flat ordinal, lowest to highest:
`viewer < agent < admin < owner` (`src/lib/auth/roles.ts`). Route
handlers call `requireRole('agent' | 'admin' | ...)` from
`src/lib/auth/account.ts`, which resolves the caller's role for the
current account and throws a typed `ForbiddenError` (→ 403) if it's too
low. **Capability predicates** (`canEditSettings`, `canSendMessages`,
`canManageMembers`, …) are the single source of truth for "what can this
role do" — both API guards and UI gates call them instead of comparing
role strings inline.

A cross-tenant `/admin` panel exists for the platform operator (you) to
see aggregate usage across every account. It's gated separately —
`requirePlatformAdmin()` (`src/lib/auth/platform-admin.ts`) — because
`requireRole` only ever proves "a role within one account," never
"allowed to read every account." See `automations-and-cron.md` for the
`PLATFORM_OPERATOR_ACCOUNT_ID` / `PLATFORM_ADMIN_USER_IDS` env vars that
configure it.

**Every external side effect (send a WhatsApp/Instagram message, touch
payment config, mutate a template) sits behind a role check *before*
the network call** — added in the Sprint 0 pass after an audit found
routes that checked "is this user logged in" but not "does this role
allow it," letting a `viewer` reach the WhatsApp send API before RLS
ever got a chance to reject the resulting DB write.

## Reliability patterns (Sprint 0)

Four related problems, four related fixes — all landed together because
building new features on top of any one of them unfixed would have made
the eventual fix harder, not easier.

### 1. Inbound webhooks are durable, not best-effort

WhatsApp, Instagram, and Asaas webhooks used to do their real work
inside `after()` — a background callback tied to that one request's
lifetime. If the serverless function was frozen or recycled before
`after()` finished, the work vanished with no error, no log, no retry.

Now: the raw request body is persisted (keyed by provider + a content
hash, migrations `054`/`060`/`062`) *before* any processing starts, and
processing is marked done only on success. A cron route
(`/api/webhooks/inbound/cron`) reserves and replays anything still
pending past its lease. `after()` is now just the fast path; the queue
is what guarantees eventual completion. The billing webhook
(`/api/billing/webhook`) uses the same shape via two SQL functions,
`record_asaas_billing_event`/`process_asaas_billing_event`, serialized
by Asaas event id and by gateway payment id so a replayed
`PAYMENT_CONFIRMED` can't grant a subscription period twice.

### 2. Checkout is transactional end-to-end

Placing an order used to be several independent writes (create order →
insert items → charge → update cart). A double-click, a slow network
retry, or a crash mid-sequence could mint two orders/PIX charges for one
cart, or leave one in a half-written state. `src/lib/orders/checkout.ts`
now does the whole thing as one guarded operation with a cart-level
lock and an idempotency key passed to the payment gateway, so retrying
the exact same checkout is safe.

### 3. Broadcast delivery is a durable, lease-based queue

Same class of problem as (1), applied to outbound: sending a broadcast
campaign used to run in the browser tab or in `after()` — close the tab
mid-campaign and the rest silently never sends. `broadcast_delivery_jobs`
(migration `055`) holds one row per recipient with `status`,
`attempts`, `next_run_at`, and a `lease_expires_at`; `/api/whatsapp/
broadcast/cron` claims a batch with `SKIP LOCKED` and drains it. Safe to
invoke concurrently or redundantly — the lease is what prevents a
recipient being sent to twice.

### 4. One shared entitlement gate

Trial/subscription status used to be checked ad hoc, differently, in
different places — and some API routes and public-facing links weren't
checked at all, so an expired trial could keep using WhatsApp sends, the
AI agent, and automations through those gaps. `src/lib/billing/
account-entitlement.ts` is now the one function every page, API route,
and cron job consults to decide "does this account currently have
access."

### Migration-role footgun (if you write new SQL migrations)

The Supabase CLI's `db push` runs migrations under a role whose
`search_path` does **not** include the `extensions` schema — even
though `CREATE EXTENSION IF NOT EXISTS foo;` succeeds, a bare call to a
function that extension defines (`uuid_generate_v4()`, `digest()`, …)
fails with "function does not exist," while the *exact same SQL* works
fine pasted into the Supabase Dashboard's SQL editor (different role,
different search_path). This bit both this session's own migrations and
an earlier one (046). The fix is always the same: prefer the
`pg_catalog` built-in that needs no extension —
`gen_random_uuid()` instead of `uuid_generate_v4()` (uuid-ossp),
`sha256(x::bytea)` instead of `digest(x, 'sha256')` (pgcrypto, PG14+).

## Data model highlights

- **Contacts** are channel-agnostic: `phone` (WhatsApp) and
  `instagram_scoped_id` (Instagram) are both nullable — a contact has
  whichever identity its channel provides, never both required.
  `conversations.channel` (`'whatsapp' | 'instagram'`) tells every send
  path which provider to use.
- **Catalog → cart → order**: `catalog_items` (what a tenant sells) →
  `cart_items` (WhatsApp-side, pre-checkout) → `orders`/`order_items`
  (immutable once paid) → `orders.invoice_id`/`invoice_status` (Asaas
  NFS-e, issued async after payment — the "Ver NF" button, shared as
  `InvoiceCard`, calls Asaas live rather than trusting a cached
  status). `orders.source` distinguishes a WhatsApp-checkout order from
  a comanda opened directly in `/orders` ("Nova comanda"); either way,
  `order_payments` (migration 064) is where a payment recorded by hand
  — cash, card, a PIX outside Asaas — lands, separate from the
  automatic Asaas-webhook flow. `accounts.logo_url` (+ the existing
  `accounts.name`) is the whitelabel identity shown on documents IMCRM
  itself generates (the receipt today) — never on the official NFS-e
  PDF, whose layout the municipality/Asaas controls.
- **Tasks & activities** (migration `063`) — see below.
- **Automations** (`automations`/`automation_steps`) are trigger-
  agnostic: the same step types (`add_tag`, `create_deal`, …) fire
  regardless of whether the trigger was a WhatsApp keyword or an
  Instagram comment, because they only ever need a `contact_id`.

## Tasks & "Hoje" (Today)

The first "operate the business day to day" surface, replacing "check
five different tabs to find out what needs attention" with one list.

- `tasks` — `status` (`open`/`completed`/`canceled`), `priority`
  (`low`/`normal`/`high`/`urgent`), optional `due_at`, and optional
  links to a contact/deal/order/conversation. Completing sets
  `completed_at`; reopening clears it (enforced by a CHECK constraint,
  not just app code).
- `activities` — an **append-only** timeline (`event_type` like
  `task.completed`, `deal.status_changed`; `entity_type` +
  `entity_id`). Nothing updates or deletes a row here; a correction is
  a new row. This is what backs the contact detail view's history and
  the account-wide feed on `/today`.
- `/today` is the new post-login landing page (`/dashboard` remains
  the analytics view, one click away): overdue + due-today tasks,
  recent activity, and quick task creation. `/tasks` is the full
  workspace (filters, all-time list). Both are built on
  `src/components/tasks/task-workspace.tsx`, which also powers the
  compact "Tasks" tab inside the contact detail sidebar
  (`view="contact"`) — one component, three surfaces.

## APIs

- **Internal** (`/api/*`, used by the dashboard itself): cookie-session
  auth via `requireRole`/`getCurrentAccount`
  (`src/lib/auth/account.ts`). Not meant for third-party use — no
  stability guarantee on response shapes.
- **Public v1** (`/api/v1/*`): API-key auth, documented in
  [`public-api.md`](./public-api.md). This is the stable, versioned
  surface for anything external (Zapier-style integrations, a tenant's
  own scripts).
- **Webhooks IMCRM receives**: `/api/whatsapp/webhook` (Meta),
  `/api/whatsapp/worker-webhook` (Baileys worker), `/api/instagram/
  webhook`, `/api/orders/webhook` (Asaas, tenant-level order payment),
  `/api/billing/webhook` (Asaas, platform-level subscription billing).
  All Meta-family ones share `verifyMetaWebhookSignature`
  (`src/lib/whatsapp/webhook-signature.ts`); the two Asaas ones use a
  constant-time token compare instead (Asaas has no HMAC signing).
- **Webhooks IMCRM sends**: per-account `webhook_endpoints`
  subscribers (`message.received`, `conversation.created`, …),
  delivered durably — see `automations-and-cron.md`.

## Operations checklist

- Required env vars are documented inline in `.env.local.example`;
  the ones that gate whole subsystems (fail closed, not open, if
  missing) are `AUTOMATION_CRON_SECRET`, `ASAAS_WEBHOOK_TOKEN`,
  `META_APP_SECRET`, `ENCRYPTION_KEY`.
- Cron: see `automations-and-cron.md` — nothing is scheduled by the
  platform itself; an external pinger drives every recurring job.
- Migrations: `npx supabase db push`. If a migration fails with
  "function does not exist" for something that's clearly installed,
  see the migration-role footgun above before assuming the extension
  is missing.
- Deploy: `vercel --prod --yes`, then **always**
  `vercel alias set <new-deployment-url> crm.imdigitalsolutions.com.br`
  — the custom domain does not automatically follow a new production
  deploy.
- `whatsapp-worker/` (the Baileys integration) is a separate deployment
  target with its own Dockerfile — `vercel --prod` does not touch it.
