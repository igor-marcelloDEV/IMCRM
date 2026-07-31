import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

/**
 * POST /api/tasks/[id]/activities — log a manual progress update
 * ("andamento") against a task, optionally with a link or an
 * uploaded file (image/PDF, already staged in Storage by the client
 * via uploadAccountMedia before this call). Reuses the same
 * `activities` table and `append_activity` RPC as everything else
 * (task completion, order lifecycle) rather than a new table — an
 * andamento is just another timeline entry, entity_type 'task'.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: taskId } = await params;
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
  if (!summary) {
    return NextResponse.json({ error: "Escreva uma atualização" }, { status: 400 });
  }
  if (summary.length > 500) {
    return NextResponse.json({ error: "Atualização muito longa (máx. 500 caracteres)" }, { status: 400 });
  }
  const linkUrl = typeof body?.link_url === "string" && body.link_url.trim() ? body.link_url.trim() : null;
  const attachmentUrl = typeof body?.attachment_url === "string" && body.attachment_url.trim()
    ? body.attachment_url.trim()
    : null;
  const attachmentType = body?.attachment_type === "image" || body?.attachment_type === "document"
    ? body.attachment_type
    : null;
  if (attachmentUrl && !attachmentType) {
    return NextResponse.json({ error: "'attachment_type' é obrigatório quando 'attachment_url' é definido" }, { status: 400 });
  }

  const { data: task } = await ctx.supabase
    .from("tasks")
    .select("id, contact_id, deal_id, order_id, conversation_id")
    .eq("id", taskId)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (!task) {
    return NextResponse.json({ error: "Tarefa não encontrada" }, { status: 404 });
  }

  const db = supabaseAdmin();
  const { error } = await db.rpc("append_activity", {
    p_account_id: ctx.accountId,
    p_actor_id: ctx.userId,
    p_event_type: "task.progress_update",
    p_entity_type: "task",
    p_entity_id: taskId,
    p_summary: summary,
    p_metadata: { link_url: linkUrl, attachment_url: attachmentUrl, attachment_type: attachmentType },
    p_task_id: taskId,
    p_contact_id: task.contact_id,
    p_deal_id: task.deal_id,
    p_order_id: task.order_id,
    p_conversation_id: task.conversation_id,
  });
  if (error) {
    console.error("[POST /api/tasks/[id]/activities] append_activity error:", error);
    return NextResponse.json({ error: "Não foi possível registrar a atualização" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
