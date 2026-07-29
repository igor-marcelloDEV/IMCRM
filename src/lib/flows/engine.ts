/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import { createOrGetCustomer, createPixPayment } from "@/lib/billing/asaas";
import { getTenantAsaasConfig } from "@/lib/orders/tenant-asaas";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import {
  type CheckoutNodeConfig,
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type ShowCatalogNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Text-reply fallback for a `send_buttons`/`send_list` node, for
 * providers with no real tappable buttons (Baileys/WhatsApp Web —
 * `BaileysWorkerProvider.sendInteractive` degrades the prompt to a
 * numbered text menu via `renderInteractiveAsText`). Matches the
 * customer's typed reply against option POSITION ("2") or TITLE text
 * ("Site novo"), so a menu sent as text still advances the run the
 * same way a real button tap would via `matchReplyId`.
 *
 * Position numbering must stay in lockstep with
 * `renderInteractiveAsText` in src/lib/whatsapp/interactive.ts — both
 * number buttons/list-rows 1-indexed, continuously across list
 * sections (no per-section reset).
 */
export function matchReplyText(
  node: { node_type: string; config: Record<string, unknown> },
  text: string,
): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    return matchOptionByPositionOrTitle(cfg.buttons ?? [], trimmed);
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    const options = (cfg.sections ?? []).flatMap((section) => section.rows ?? []);
    return matchOptionByPositionOrTitle(options, trimmed);
  }
  return null;
}

function matchOptionByPositionOrTitle(
  options: Array<{ title: string; next_node_key: string }>,
  trimmed: string,
): string | null {
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return options[asNumber - 1].next_node_key;
  }
  const normalized = trimmed.toLowerCase();
  const hit = options.find((o) => o.title.trim().toLowerCase() === normalized);
  return hit?.next_node_key ?? null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input" ||
    node_type === "show_catalog" ||
    node_type === "checkout"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  // Only text messages can match an entry trigger. Interactive replies
  // are responses to existing prompts; they never start a new flow.
  if (message.kind !== "text") return null;

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      if (matchesKeywordTrigger(
        message.text,
        flow.trigger_config as KeywordTriggerConfig,
      )) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections: cfg.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: r.title,
        description: r.description,
      })),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

// ============================================================
// Commerce — show_catalog / checkout node types.
//
// Both are "dynamic" nodes: their outbound content is built from live
// `catalog_items`/`cart_items` rows at send time rather than authored
// on the canvas, and tapping a product/upsell row RE-ENTERS the same
// node (the reply handler sets `matched = currentNode.node_key`,
// which `advanceFromNodeKey` treats like any other advance — see
// `handleReplyForActiveRun`). The only genuinely new control-flow
// shape is `checkout`'s CPF/CNPJ prompt: it needs to suspend WITHOUT
// re-sending the cart-review list, tracked via a `vars` flag
// (`__checkout_awaiting_cpf`) rather than a new run-state column —
// same "scratch space" role `vars` already plays for collect_input.
//
// No payment call yet (v1.5 scope) — `createOrderFromCart` records
// the order as `pending_payment` and creates the linked Deal; the
// Asaas charge is wired in once per-tenant payment config ships.
// ============================================================

const CATALOG_CHECKOUT_REPLY_ID = "__checkout__";
const CHECKOUT_FINALIZE_REPLY_ID = "__finalize__";
const MAX_CATALOG_ROWS = 9; // + the reserved checkout row = Meta's 10-row cap
const MAX_UPSELL_ROWS = 9;
const DEFAULT_CPF_PROMPT =
  "Pra emitir a cobrança, me informa seu CPF ou CNPJ:";

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

/** Meta list row titles cap at 24 chars (INTERACTIVE_LIMITS.listRowTitleMaxLength). */
function truncateForList(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

async function loadAccountCurrency(db: AdminClient, accountId: string): Promise<string> {
  const { data } = await db
    .from("accounts")
    .select("default_currency")
    .eq("id", accountId)
    .maybeSingle();
  return (data as { default_currency?: string } | null)?.default_currency ?? "BRL";
}

interface ActiveCatalogItem {
  id: string;
  name: string;
  price_cents: number;
}

async function loadActiveCatalogItems(
  db: AdminClient,
  accountId: string,
  limit: number,
): Promise<ActiveCatalogItem[]> {
  const { data } = await db
    .from("catalog_items")
    .select("id, name, price_cents")
    .eq("account_id", accountId)
    .eq("is_active", true)
    .order("position", { ascending: true })
    .limit(limit);
  return (data as ActiveCatalogItem[] | null) ?? [];
}

/**
 * Get the contact's open cart, creating one if none exists. Races
 * against `idx_one_open_cart_per_contact` (migration 046) — a losing
 * concurrent INSERT re-reads rather than erroring, same pattern
 * `startNewRun`'s 23505 handling uses for flow_runs.
 */
export async function getOrCreateOpenCart(
  db: AdminClient,
  args: { accountId: string; contactId: string; conversationId: string | null },
): Promise<string> {
  const { data: existing } = await db
    .from("carts")
    .select("id")
    .eq("contact_id", args.contactId)
    .eq("status", "open")
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;

  const { data: created, error } = await db
    .from("carts")
    .insert({
      account_id: args.accountId,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
    })
    .select("id")
    .maybeSingle();
  if (created) return (created as { id: string }).id;

  if (error) {
    const { data: retry } = await db
      .from("carts")
      .select("id")
      .eq("contact_id", args.contactId)
      .eq("status", "open")
      .maybeSingle();
    if (retry) return (retry as { id: string }).id;
  }
  throw error ?? new Error("failed to create cart");
}

/**
 * Validates `catalogItemId` belongs to this account and is active,
 * then upserts it into the contact's open cart (incrementing quantity
 * on a repeat add). Returns the item's name on success, or `null` if
 * the id doesn't resolve to a live catalog item — the caller treats
 * that the same as "no match" (stale button, tampered reply_id).
 */
export async function addCatalogItemToCart(
  db: AdminClient,
  args: {
    accountId: string;
    contactId: string;
    conversationId: string | null;
    catalogItemId: string;
  },
): Promise<{ name: string } | null> {
  const { data: item } = await db
    .from("catalog_items")
    .select("id, name, price_cents")
    .eq("account_id", args.accountId)
    .eq("id", args.catalogItemId)
    .eq("is_active", true)
    .maybeSingle();
  if (!item) return null;
  const typedItem = item as { id: string; name: string; price_cents: number };

  const cartId = await getOrCreateOpenCart(db, args);
  const { data: line } = await db
    .from("cart_items")
    .select("id, quantity")
    .eq("cart_id", cartId)
    .eq("catalog_item_id", typedItem.id)
    .maybeSingle();
  if (line) {
    const typedLine = line as { id: string; quantity: number };
    await db
      .from("cart_items")
      .update({ quantity: typedLine.quantity + 1 })
      .eq("id", typedLine.id);
  } else {
    await db.from("cart_items").insert({
      cart_id: cartId,
      catalog_item_id: typedItem.id,
      quantity: 1,
      unit_price_cents: typedItem.price_cents,
    });
  }
  return { name: typedItem.name };
}

interface CartLine {
  catalogItemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
}

interface CartSummary {
  cartId: string;
  lines: CartLine[];
  subtotalCents: number;
}

/**
 * Two separate queries (cart_items, then catalog_items by id) rather
 * than an embedded FK select — PostgREST's embedded-relationship
 * resolution needs its schema cache to already know the FK, which is
 * exactly the thing most likely to be stale right after the migration
 * that added these tables (see use-auth.tsx's getCurrentAccount for
 * the same rationale, issue #294).
 */
async function loadCartSummary(
  db: AdminClient,
  contactId: string,
): Promise<CartSummary | null> {
  const { data: cart } = await db
    .from("carts")
    .select("id")
    .eq("contact_id", contactId)
    .eq("status", "open")
    .maybeSingle();
  if (!cart) return null;
  const cartId = (cart as { id: string }).id;

  const { data: items } = await db
    .from("cart_items")
    .select("catalog_item_id, quantity, unit_price_cents")
    .eq("cart_id", cartId);
  const rows =
    (items as Array<{ catalog_item_id: string; quantity: number; unit_price_cents: number }> | null) ?? [];
  if (rows.length === 0) return { cartId, lines: [], subtotalCents: 0 };

  const { data: catalogRows } = await db
    .from("catalog_items")
    .select("id, name")
    .in(
      "id",
      rows.map((r) => r.catalog_item_id),
    );
  const nameById = new Map(
    ((catalogRows as Array<{ id: string; name: string }> | null) ?? []).map((c) => [c.id, c.name]),
  );

  const lines: CartLine[] = rows.map((r) => ({
    catalogItemId: r.catalog_item_id,
    name: nameById.get(r.catalog_item_id) ?? "Item",
    quantity: r.quantity,
    unitPriceCents: r.unit_price_cents,
    subtotalCents: r.quantity * r.unit_price_cents,
  }));
  return { cartId, lines, subtotalCents: lines.reduce((s, l) => s + l.subtotalCents, 0) };
}

/**
 * Side-effecting order creation — mirrors the automations engine's
 * `create_deal` step (same explicit pipeline_id/stage_id requirement,
 * same account default_currency lookup). Snapshots the cart into
 * `order_items` so later catalog edits never rewrite history, then
 * closes the cart. No-ops (returns null) on an empty cart — callers
 * only reach this after `sendCheckoutAndSuspend` has already refused
 * to let an empty cart finalize.
 */
async function createOrderFromCart(
  db: AdminClient,
  run: FlowRunRow,
  cfg: CheckoutNodeConfig,
): Promise<{ orderId: string } | null> {
  const summary = await loadCartSummary(db, run.contact_id!);
  if (!summary || summary.lines.length === 0) return null;

  const currency = await loadAccountCurrency(db, run.account_id);

  const { data: order, error } = await db
    .from("orders")
    .insert({
      account_id: run.account_id,
      cart_id: summary.cartId,
      contact_id: run.contact_id,
      status: "pending_payment",
      subtotal_cents: summary.subtotalCents,
      total_cents: summary.subtotalCents,
      currency,
    })
    .select("id")
    .maybeSingle();
  if (error || !order) return null;
  const orderId = (order as { id: string }).id;

  await db.from("order_items").insert(
    summary.lines.map((l) => ({
      order_id: orderId,
      catalog_item_id: l.catalogItemId,
      name_snapshot: l.name,
      quantity: l.quantity,
      unit_price_cents: l.unitPriceCents,
      total_cents: l.subtotalCents,
    })),
  );

  // Linked Deal (per the confirmed design — the tenant closes the
  // sale by dragging this deal to a won stage; nothing here moves it
  // automatically, including once payment is confirmed).
  const { data: deal } = await db
    .from("deals")
    .insert({
      account_id: run.account_id,
      user_id: run.user_id,
      pipeline_id: cfg.pipeline_id,
      stage_id: cfg.stage_id,
      contact_id: run.contact_id,
      conversation_id: run.conversation_id,
      title: "Pedido via WhatsApp",
      value: summary.subtotalCents / 100,
      currency,
      status: "open",
    })
    .select("id")
    .maybeSingle();
  if (deal) {
    await db.from("orders").update({ deal_id: (deal as { id: string }).id }).eq("id", orderId);
  }

  await db.from("carts").update({ status: "checked_out" }).eq("id", summary.cartId);
  return { orderId };
}

/**
 * Charges the order via the TENANT's own Asaas account (PIX only —
 * matches the platform billing client's own rationale: PIX has no
 * recurring mandate in Brazil, so a one-off charge per order is the
 * correct shape here regardless). Degrades gracefully at every step —
 * a tenant who hasn't configured Asaas yet, or whose key has gone
 * bad, still gets a registered order; they just don't get an
 * automated charge, and the checkout node's own `next_node_key`
 * message is what tells the customer what happens next.
 *
 * QR code image is intentionally NOT sent — Asaas returns it as a
 * base64 PNG (`encodedImage`), and WhatsApp media sends need a
 * fetchable URL, not raw bytes. The copy-paste PIX payload (`payload`)
 * covers the same use case without needing to host an image.
 */
async function chargeOrderViaAsaas(
  db: AdminClient,
  run: FlowRunRow,
  orderId: string,
): Promise<void> {
  const config = await getTenantAsaasConfig(db, run.account_id);
  if (!config) return;

  const { data: order } = await db
    .from("orders")
    .select("total_cents, currency")
    .eq("id", orderId)
    .maybeSingle();
  const { data: contact } = await db
    .from("contacts")
    .select("name, email, phone, cpf_cnpj")
    .eq("id", run.contact_id!)
    .maybeSingle();
  const typedOrder = order as { total_cents: number; currency: string } | null;
  const typedContact =
    (contact as { name: string | null; email: string | null; phone: string; cpf_cnpj: string | null } | null);
  if (!typedOrder || !typedContact?.cpf_cnpj) return;

  try {
    const customer = await createOrGetCustomer({
      config,
      name: typedContact.name || "Cliente WhatsApp",
      // Asaas requires an email to create a customer; WhatsApp contacts
      // frequently don't have one captured. A per-contact placeholder
      // keeps customer records distinct without blocking the charge.
      email: typedContact.email || `contato-${run.contact_id}@sememail.imcrm.app`,
      phone: typedContact.phone,
      cpfCnpj: typedContact.cpf_cnpj,
      externalReference: run.contact_id!,
    });

    const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { payment, qrCode } = await createPixPayment({
      config,
      customerId: customer.id,
      value: typedOrder.total_cents / 100,
      dueDate,
      description: "Pedido via WhatsApp",
      externalReference: orderId,
    });

    await db
      .from("orders")
      .update({ gateway_customer_id: customer.id, gateway_payment_id: payment.id })
      .eq("id", orderId);

    await engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text: `Pra confirmar seu pedido, pague via PIX (copia e cola):\n\n${qrCode.payload}\n\nValor: ${formatCents(typedOrder.total_cents, typedOrder.currency)}`,
    });
  } catch (err) {
    // Bad/expired key, Asaas outage, etc. — don't strand the customer
    // without any response; the order itself already exists.
    await logEvent(db, run.id, "error", "checkout", {
      reason: "asaas_charge_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Sends the live catalog as an interactive list + a reserved
 * "checkout" row, and stashes the message id for inbox quoting — same
 * bookkeeping `sendListAndSuspend` does. Safe to call repeatedly on
 * the same node (the loop path): each call re-queries catalog/cart
 * state, so the cart line in the body text is always current.
 */
async function sendCatalogAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as unknown as ShowCatalogNodeConfig;
  const items = await loadActiveCatalogItems(db, run.account_id, MAX_CATALOG_ROWS);
  const summary = await loadCartSummary(db, run.contact_id!);
  const cartCount = summary?.lines.length ?? 0;
  const cartLine =
    cartCount > 0
      ? `\n\n🛒 Carrinho: ${cartCount} ite${cartCount === 1 ? "m" : "ns"} — ${formatCents(summary!.subtotalCents, await loadAccountCurrency(db, run.account_id))}`
      : "";
  const bodyText = `${interpolateVars(cfg.intro_text || "Veja nosso catálogo:", run.vars)}${cartLine}`;

  const currency = await loadAccountCurrency(db, run.account_id);
  const rows = items.map((it) => ({
    id: it.id,
    title: truncateForList(it.name, 24),
    description: formatCents(it.price_cents, currency),
  }));
  rows.push({
    id: CATALOG_CHECKOUT_REPLY_ID,
    title: "🛒 Fechar pedido",
    description: cartCount > 0 ? `${cartCount} ite${cartCount === 1 ? "m" : "ns"} no carrinho` : "Carrinho vazio",
  });

  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText,
    buttonLabel: "Ver opções",
    sections: [{ rows }],
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "show_catalog",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({ last_prompt_message_id: (msg as { id: string } | null)?.id ?? null })
    .eq("id", run.id);
}

/**
 * Sends the cart review (line items + total), up to MAX_UPSELL_ROWS
 * suggestion rows, and a "Finalizar pedido" row. Returns
 * `{ ended: true }` when the cart is empty — the caller must not
 * suspend on a node that just ended the run.
 */
async function sendCheckoutAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ ended: boolean }> {
  const summary = await loadCartSummary(db, run.contact_id!);
  const currency = await loadAccountCurrency(db, run.account_id);

  if (!summary || summary.lines.length === 0) {
    try {
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: "Seu carrinho está vazio no momento.",
      });
    } catch {
      // Best-effort — ending the run matters more than this send.
    }
    await logEvent(db, run.id, "completed", node.node_key, { reason: "empty_cart_at_checkout" });
    await endRun(db, run.id, "completed", "empty_cart_at_checkout");
    return { ended: true };
  }

  const cartItemIds = new Set(summary.lines.map((l) => l.catalogItemId));
  const { data: upsellRaw } = await db
    .from("catalog_items")
    .select("id, name, price_cents")
    .eq("account_id", run.account_id)
    .eq("is_active", true)
    .eq("is_upsell", true)
    .limit(MAX_UPSELL_ROWS + cartItemIds.size);
  const upsellCandidates = (upsellRaw as ActiveCatalogItem[] | null) ?? [];
  const upsellRows = upsellCandidates
    .filter((c) => !cartItemIds.has(c.id))
    .slice(0, MAX_UPSELL_ROWS)
    .map((c) => ({
      id: c.id,
      title: truncateForList(c.name, 24),
      description: `+ ${formatCents(c.price_cents, currency)}`,
    }));

  const lineText = summary.lines
    .map((l) => `• ${l.quantity}x ${l.name} — ${formatCents(l.subtotalCents, currency)}`)
    .join("\n");
  const bodyText = `Seu pedido:\n${lineText}\n\nTotal: ${formatCents(summary.subtotalCents, currency)}`;

  const rows = [
    ...upsellRows,
    { id: CHECKOUT_FINALIZE_REPLY_ID, title: "✅ Finalizar pedido", description: "Confirmar e enviar" },
  ];

  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText,
    buttonLabel: "Ver opções",
    sections: [{ rows }],
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "checkout",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({ last_prompt_message_id: (msg as { id: string } | null)?.id ?? null })
    .eq("id", run.id);
  return { ended: false };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await addContactTagAndDispatch({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await removeContactTag(db, {
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
          });
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      await sendButtonsAndSuspend(db, run, node);
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      await sendListAndSuspend(db, run, node);
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "show_catalog") {
      await sendCatalogAndSuspend(db, run, node);
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "checkout") {
      const { ended } = await sendCheckoutAndSuspend(db, run, node);
      if (ended) {
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Three ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a send_buttons/send_list node — providers with
  //      no real buttons (Baileys) degrade the prompt to a numbered
  //      text menu, so a typed "1"/"2"/title also counts as a tap.
  //   3. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === "text" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyText(currentNode, message.text);
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      // Persist captured value + reset reprompt count atomically.
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      const { error: capErr } = await db
        .from("flow_runs")
        .update({
          vars: newVars,
          reprompt_count: 0,
        })
        .eq("id", run.id);
      if (!capErr) {
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(db, run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        matched = cfg.next_node_key;
      }
    }
  } else if (
    message.kind === "interactive_reply" &&
    currentNode.node_type === "show_catalog"
  ) {
    const cfg = currentNode.config as unknown as ShowCatalogNodeConfig;
    if (message.reply_id === CATALOG_CHECKOUT_REPLY_ID) {
      matched = cfg.next_node_key;
    } else {
      const added = await addCatalogItemToCart(db, {
        accountId: run.account_id,
        contactId: run.contact_id!,
        conversationId: run.conversation_id,
        catalogItemId: message.reply_id,
      });
      // Loop — re-send the same node so the customer sees the updated
      // cart total and can keep browsing. A stale/tampered reply_id
      // (added === null) falls through to the fallback policy below,
      // same as an unrecognized send_buttons/send_list tap.
      if (added) matched = currentNode.node_key;
    }
  } else if (
    message.kind === "interactive_reply" &&
    currentNode.node_type === "checkout"
  ) {
    const cfg = currentNode.config as unknown as CheckoutNodeConfig;
    if (message.reply_id === CHECKOUT_FINALIZE_REPLY_ID) {
      const { data: contact } = await db
        .from("contacts")
        .select("cpf_cnpj")
        .eq("id", run.contact_id!)
        .maybeSingle();
      const cpfOnFile = (contact as { cpf_cnpj?: string | null } | null)?.cpf_cnpj;
      if (cpfOnFile) {
        const created = await createOrderFromCart(db, run, cfg);
        if (created) await chargeOrderViaAsaas(db, run, created.orderId);
        matched = cfg.next_node_key;
      } else {
        // Ask once, suspend WITHOUT re-sending the cart list — the
        // next TEXT reply is captured by the branch below.
        try {
          await engineSendText({
            accountId: run.account_id,
            userId: run.user_id,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            text: interpolateVars(cfg.cpf_cnpj_prompt || DEFAULT_CPF_PROMPT, run.vars),
          });
        } catch (err) {
          await logEvent(db, run.id, "error", currentNode.node_key, {
            reason: "cpf_prompt_send_failed",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        const newVars = { ...run.vars, __checkout_awaiting_cpf: true };
        await db.from("flow_runs").update({ vars: newVars }).eq("id", run.id);
        run.vars = newVars;
        return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
      }
    } else {
      const added = await addCatalogItemToCart(db, {
        accountId: run.account_id,
        contactId: run.contact_id!,
        conversationId: run.conversation_id,
        catalogItemId: message.reply_id,
      });
      if (added) matched = currentNode.node_key;
    }
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "checkout" &&
    run.vars.__checkout_awaiting_cpf === true
  ) {
    const cfg = currentNode.config as unknown as CheckoutNodeConfig;
    const cpf = message.text.trim();
    if (cpf.length > 0) {
      await db.from("contacts").update({ cpf_cnpj: cpf }).eq("id", run.contact_id!);
      const newVars = { ...run.vars };
      delete newVars.__checkout_awaiting_cpf;
      await db.from("flow_runs").update({ vars: newVars }).eq("id", run.id);
      run.vars = newVars;
      const created = await createOrderFromCart(db, run, cfg);
      if (created) await chargeOrderViaAsaas(db, run, created.orderId);
      matched = cfg.next_node_key;
    }
    // Empty text → falls through to the fallback/reprompt policy,
    // which re-sends the same cpf_cnpj_prompt (see below).
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    if (currentNode.node_type === "send_buttons") {
      await sendButtonsAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "send_list") {
      await sendListAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "collect_input") {
      // Customer typed something we couldn't accept (empty after trim,
      // or var_key missing — rare). Re-send the prompt so they try again.
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (currentNode.node_type === "show_catalog") {
      await sendCatalogAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "checkout") {
      if (run.vars.__checkout_awaiting_cpf === true) {
        const cfg = currentNode.config as unknown as CheckoutNodeConfig;
        try {
          await engineSendText({
            accountId: run.account_id,
            userId: run.user_id,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            text: interpolateVars(cfg.cpf_cnpj_prompt || DEFAULT_CPF_PROMPT, run.vars),
          });
        } catch (err) {
          await logEvent(db, run.id, "error", currentNode.node_key, {
            reason: "reprompt_send_failed",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        await sendCheckoutAndSuspend(db, run, currentNode);
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(db, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
