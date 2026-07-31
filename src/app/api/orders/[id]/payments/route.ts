import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const VALID_METHODS = ["cash", "card", "pix_manual", "pix_asaas", "other"] as const;

/**
 * POST /api/orders/[id]/payments — record a payment by hand (cash,
 * card, a PIX paid outside Asaas). Independent of the automatic Asaas
 * flow, which marks orders.status = 'paid' directly from the orders
 * webhook — this is the manual equivalent for a comanda, and supports
 * splitting one order across multiple payments/methods.
 *
 * The order is marked 'paid' the moment recorded payments cover the
 * total — checked here, not in a trigger, so "what makes an order
 * paid" stays readable in one place next to the write that causes it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: orderId } = await params;
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const method = typeof body?.method === "string" ? body.method : "";
  const amountCents = Number(body?.amount_cents);
  const notes = typeof body?.notes === "string" ? body.notes.trim() || null : null;

  if (!(VALID_METHODS as readonly string[]).includes(method)) {
    return NextResponse.json(
      { error: `method deve ser um de: ${VALID_METHODS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return NextResponse.json({ error: "amount_cents deve ser um inteiro positivo" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: order } = await db
    .from("orders")
    .select("id, status, total_cents")
    .eq("id", orderId)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (!order) return NextResponse.json({ error: "Pedido não encontrado" }, { status: 404 });
  if (order.status === "canceled") {
    return NextResponse.json({ error: "Este pedido está cancelado" }, { status: 409 });
  }
  if (order.status === "paid") {
    return NextResponse.json({ error: "Este pedido já está totalmente pago" }, { status: 409 });
  }

  const { error: insertError } = await db.from("order_payments").insert({
    account_id: ctx.accountId,
    order_id: orderId,
    method,
    amount_cents: amountCents,
    notes,
    recorded_by: ctx.userId,
  });
  if (insertError) {
    console.error("[POST /api/orders/[id]/payments] insert error:", insertError);
    return NextResponse.json({ error: "Não foi possível registrar o pagamento" }, { status: 500 });
  }

  const { data: payments } = await db
    .from("order_payments")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  const paidCents = ((payments ?? []) as Array<{ amount_cents: number }>).reduce(
    (s, p) => s + p.amount_cents,
    0,
  );

  let updatedOrder = order;
  if (paidCents >= order.total_cents) {
    const { data } = await db
      .from("orders")
      .update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("id", orderId)
      .select("*")
      .single();
    if (data) updatedOrder = data;
  }

  return NextResponse.json({
    order: updatedOrder,
    payments: payments ?? [],
    paid_cents: paidCents,
    balance_cents: Math.max(0, order.total_cents - paidCents),
  });
}
