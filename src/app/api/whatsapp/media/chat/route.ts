import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  CHAT_MEDIA_BUCKET,
  isChatMediaPathForAccount,
} from "@/lib/storage/chat-media";

const PRIVATE_NO_STORE = "private, no-store, max-age=0";

function privateJson(error: string, status: number) {
  return NextResponse.json(
    { error },
    {
      status,
      headers: {
        "Cache-Control": PRIVATE_NO_STORE,
        Pragma: "no-cache",
      },
    },
  );
}

/**
 * Authenticated proxy for durable chat history URLs. The object path is
 * checked against the caller's account before Storage is touched, and the
 * RLS-scoped client performs the actual download as a second boundary.
 */
export async function GET(request: Request) {
  let context: Awaited<ReturnType<typeof getCurrentAccount>>;
  try {
    context = await getCurrentAccount();
  } catch (error) {
    const response = toErrorResponse(error);
    response.headers.set("Cache-Control", PRIVATE_NO_STORE);
    response.headers.set("Pragma", "no-cache");
    return response;
  }

  const path = new URL(request.url).searchParams.get("path");
  if (!path) return privateJson("Caminho da mídia ausente", 400);
  if (!isChatMediaPathForAccount(path, context.accountId)) {
    return privateJson("Mídia não pertence a esta conta", 403);
  }

  try {
    const { data, error } = await context.supabase.storage
      .from(CHAT_MEDIA_BUCKET)
      .download(path);
    if (error || !data) {
      return privateJson("Mídia não encontrada", 404);
    }

    const filename = path.slice(path.lastIndexOf("/") + 1);
    return new Response(await data.arrayBuffer(), {
      status: 200,
      headers: {
        "Cache-Control": PRIVATE_NO_STORE,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Type": data.type || "application/octet-stream",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[chat-media] authenticated download failed", error);
    return privateJson("Falha ao buscar a mídia", 500);
  }
}
