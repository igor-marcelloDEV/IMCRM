# Cron endpoints

IMCRM has no built-in scheduler (no `vercel.json` cron config, no GitHub
Actions cron workflow). Every recurring job is a plain authenticated
`GET` route that does one bounded batch of work per call — an external
pinger (cron-job.org, EasyCron, a scheduled GitHub Actions workflow you
add yourself, etc.) is responsible for calling each one on a schedule.

All of them share one secret and one header:

```
GET https://<your-domain>/api/<route>
x-cron-secret: <AUTOMATION_CRON_SECRET>
```

Set `AUTOMATION_CRON_SECRET` once (`openssl rand -hex 32`) and reuse it
for every route below — a request without a matching header gets a 401,
and every route returns 503 if the env var isn't set at all (fail
closed, not fail open).

| Route | What it does | Suggested interval |
|---|---|---|
| `/api/automations/cron` | Resumes automations parked at a `wait` step. | Every 1–5 min |
| `/api/flows/cron` | Resumes Flow runs parked at a timed step. | Every 1–5 min |
| `/api/billing/nurture-cron` | Sends the 24h/48h trial-nudge automations for accounts that signed up but haven't subscribed. | Every 15–60 min |
| `/api/webhooks/cron` | Retries outbound webhook deliveries (`webhook_endpoints` subscribers) that failed and are due for a retry. | Every 1–5 min |
| `/api/webhooks/inbound/cron` | Replays inbound WhatsApp/Instagram webhook events that were persisted but didn't finish processing in the original request (e.g. the serverless function was killed mid-flight). Also prunes old processed events. | Every 1–5 min |
| `/api/whatsapp/broadcast/cron` | Drains the durable broadcast delivery queue (`broadcast_delivery_jobs`) — sends the next batch of a running campaign. | Every 1 min while campaigns are active; safe to call even when idle (no-ops) |

**The last two (`webhooks/inbound/cron`, `whatsapp/broadcast/cron`) are
new** as of the Sprint 0 reliability work — if you already have an
external scheduler configured for the first four, add these two to it
with the same secret/header. Nothing else changes.

## Why a durable queue instead of just `after()`

Every inbound webhook and every broadcast send used to run inside a
Vercel `after()` callback — best-effort background work tied to that
one request's lifetime. If the function was frozen or recycled before
`after()` finished (a real, observed failure mode, not theoretical),
the work was silently lost: a customer's WhatsApp message could vanish
without a trace, or a broadcast could stop mid-campaign with some
recipients never sent to.

The fix in both cases is the same shape: persist the unit of work to a
table *before* attempting it, mark it done only on success, and have a
cron route reserve+retry anything still pending past its lease. The
`after()` call is now just the fast path — the cron route is what
guarantees eventual completion.

## Related environment variables

- `AUTOMATION_CRON_SECRET` — required, shared by every route above.
- `ASAAS_WEBHOOK_TOKEN` — required for `/api/billing/webhook` (the
  Asaas platform-billing webhook, not a cron route, but same "fail
  closed if unset" discipline).
- `INBOUND_WEBHOOK_CRON_BATCH_SIZE` (optional, default 20, max 100).
- `BROADCAST_CRON_BATCH_SIZE` (optional, default 20, max 100).
- `PLATFORM_ADMIN_USER_IDS` (optional) — comma-separated `auth.users`
  ids allowed into the cross-tenant `/admin` operator panel. The base
  check (`PLATFORM_OPERATOR_ACCOUNT_ID`'s owner) always applies; when
  this var is also set, the signed-in user's id must *additionally* be
  in this list — an extra, tightenable boundary on top of the base
  check, not a replacement for it.
