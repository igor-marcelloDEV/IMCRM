import type { SupabaseClient } from '@supabase/supabase-js';

// Shared by the four internal item-mutation routes (orders POST/PATCH,
// deals POST/PATCH) — one place to validate a requested add-on
// selection against its product's groups (never trust client-sent
// prices) and to compute the deterministic "signature" used to decide
// whether an incoming add-on selection matches an existing order line
// or needs a new one.

export interface RequestedAddon {
  addon_id: string;
  quantity?: number;
}

export interface ResolvedAddon {
  catalog_item_addon_id: string;
  name: string;
  price_cents: number;
  quantity: number;
}

interface AddonGroupRow {
  id: string;
  catalog_item_id: string;
  name: string;
  min_select: number;
  max_select: number;
  required: boolean;
}
interface AddonRow {
  id: string;
  name: string;
  price_cents: number;
  is_active: boolean;
  group: AddonGroupRow;
}

/** Deterministic, sortable string — not a hash — so it stays readable
 *  in a support query. Two selections are "the same line" iff this
 *  string matches exactly. */
export function computeAddonsSignature(
  addons: { catalog_item_addon_id: string; quantity: number }[],
): string {
  return addons
    .map((a) => `${a.catalog_item_addon_id}:${a.quantity}`)
    .sort()
    .join(',');
}

export function addonsUnitCents(addons: ResolvedAddon[]): number {
  return addons.reduce((sum, a) => sum + a.price_cents * a.quantity, 0);
}

/**
 * Validates a requested add-on selection against `catalogItemId`'s own
 * groups — every price is re-read from the DB (never the client), and
 * every group's required/min/max rule is enforced. Returns the
 * resolved, price-safe selection ready to snapshot.
 */
export async function resolveOrderItemAddons(
  db: SupabaseClient,
  catalogItemId: string,
  requested: RequestedAddon[],
): Promise<{ ok: true; addons: ResolvedAddon[] } | { ok: false; error: string }> {
  const [{ data: allGroups }, { data: addonRows }] = await Promise.all([
    db
      .from('catalog_item_addon_groups')
      .select('id, catalog_item_id, name, min_select, max_select, required')
      .eq('catalog_item_id', catalogItemId),
    requested.length
      ? db
          .from('catalog_item_addons')
          .select('id, name, price_cents, is_active, group:catalog_item_addon_groups!inner(id, catalog_item_id, name, min_select, max_select, required)')
          .in('id', requested.map((r) => r.addon_id))
      : Promise.resolve({ data: [] as AddonRow[] }),
  ]);

  const byId = new Map(((addonRows ?? []) as unknown as AddonRow[]).map((r) => [r.id, r]));
  const resolved: ResolvedAddon[] = [];
  const countByGroup = new Map<string, number>();

  for (const req of requested) {
    const row = byId.get(req.addon_id);
    if (!row || !row.is_active || row.group.catalog_item_id !== catalogItemId) {
      return { ok: false, error: 'Adicional inválido para este item.' };
    }
    const quantity = Math.max(1, Math.round(req.quantity ?? 1));
    resolved.push({ catalog_item_addon_id: row.id, name: row.name, price_cents: row.price_cents, quantity });
    countByGroup.set(row.group.id, (countByGroup.get(row.group.id) ?? 0) + 1);
  }

  for (const group of (allGroups ?? []) as AddonGroupRow[]) {
    const count = countByGroup.get(group.id) ?? 0;
    if (group.required && count === 0) {
      return { ok: false, error: `Selecione ao menos uma opção em "${group.name}".` };
    }
    if (count > 0 && (count < group.min_select || count > group.max_select)) {
      return {
        ok: false,
        error:
          group.min_select === group.max_select
            ? `"${group.name}" exige exatamente ${group.min_select} opção(ões).`
            : `"${group.name}" exige entre ${group.min_select} e ${group.max_select} opções.`,
      };
    }
  }

  return { ok: true, addons: resolved };
}

export async function insertOrderItemAddons(
  db: SupabaseClient,
  orderItemId: string,
  addons: ResolvedAddon[],
): Promise<void> {
  if (!addons.length) return;
  await db.from('order_item_addons').insert(
    addons.map((a) => ({
      order_item_id: orderItemId,
      catalog_item_addon_id: a.catalog_item_addon_id,
      name_snapshot: a.name,
      price_cents_snapshot: a.price_cents,
      quantity: a.quantity,
    })),
  );
}

/**
 * Finds an existing order line for `catalogItemId` whose current
 * add-on selection matches `signature` exactly — the merge target for
 * "tap the same configured item again". Returns null when no line
 * matches (including "no lines at all"), meaning the caller should
 * insert a fresh line instead of incrementing one.
 */
export async function findMatchingOrderLine(
  db: SupabaseClient,
  orderId: string,
  catalogItemId: string,
  signature: string,
): Promise<{ id: string; quantity: number; unit_price_cents: number } | null> {
  const { data: lines } = await db
    .from('order_items')
    .select('id, quantity, unit_price_cents, addons:order_item_addons(catalog_item_addon_id, quantity)')
    .eq('order_id', orderId)
    .eq('catalog_item_id', catalogItemId);

  for (const line of (lines ?? []) as Array<{ id: string; quantity: number; unit_price_cents: number; addons: { catalog_item_addon_id: string | null; quantity: number }[] | null }>) {
    const lineSignature = computeAddonsSignature(
      (line.addons ?? [])
        .filter((a): a is { catalog_item_addon_id: string; quantity: number } => !!a.catalog_item_addon_id)
        .map((a) => ({ catalog_item_addon_id: a.catalog_item_addon_id, quantity: a.quantity })),
    );
    if (lineSignature === signature) return { id: line.id, quantity: line.quantity, unit_price_cents: line.unit_price_cents };
  }
  return null;
}

/** "Apply to all items" — copies the already-resolved (and thus
 *  already price-validated) selection onto every other line in the
 *  order, deliberately WITHOUT requiring that line's own product to
 *  list these add-on groups (e.g. a "sem cebola" note across unrelated
 *  dishes). Bumps each target line's total_cents to match. */
export async function applyAddonsToOtherLines(
  db: SupabaseClient,
  orderId: string,
  excludeOrderItemId: string,
  addons: ResolvedAddon[],
): Promise<void> {
  if (!addons.length) return;
  const { data: otherLines } = await db
    .from('order_items')
    .select('id, quantity, total_cents')
    .eq('order_id', orderId)
    .neq('id', excludeOrderItemId);

  const extraUnitCents = addonsUnitCents(addons);
  for (const line of (otherLines ?? []) as Array<{ id: string; quantity: number; total_cents: number }>) {
    await insertOrderItemAddons(db, line.id, addons);
    await db
      .from('order_items')
      .update({ total_cents: line.total_cents + extraUnitCents * line.quantity })
      .eq('id', line.id);
  }
}
