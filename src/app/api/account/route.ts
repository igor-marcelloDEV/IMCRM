// ============================================================
// /api/account
//
//   GET   — current caller's account + role. Any member.
//   PATCH — rename the account.                  Admin+.
//
// Why both verbs share a route file
//   They speak about the same singular resource (the caller's
//   account) and reuse the same `requireRole` plumbing. Splitting
//   them across files would duplicate the `account_id` lookup
//   without buying anything.
// ============================================================

import { NextResponse } from "next/server";

import {
  requireRole,
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { validateBrazilianTaxId } from "@/lib/brazilian-tax-id";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({
      account: ctx.account,
      role: ctx.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const MAX_NAME_LEN = 80;

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole("admin");

    // Per-user limit on admin-class mutations. Bounds accidental
    // abuse (script run in a loop) and a compromised admin session
    // spamming renames. Each admin endpoint keys its own bucket so
    // one route doesn't starve another.
    const limit = checkRateLimit(
      `admin:rename:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | {
          name?: unknown;
          logo_url?: unknown;
          legal_name?: unknown;
          cnpj?: unknown;
          store_address?: unknown;
          store_lat?: unknown;
          store_lng?: unknown;
          driver_notify_auto_enabled?: unknown;
          driver_message_template?: unknown;
        }
      | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Corpo da requisição inválido" }, { status: 400 });
    }

    // Both fields are independently optional — the whitelabel identity
    // card can save just the logo without re-sending the name, and vice
    // versa. At least one must be present, or there's nothing to do.
    const update: Record<string, unknown> = {};

    if ("name" in body) {
      if (typeof body.name !== "string") {
        return NextResponse.json(
          { error: "O campo 'name' deve ser uma string" },
          { status: 400 },
        );
      }
      const name = body.name.trim();
      if (name.length === 0) {
        return NextResponse.json(
          { error: "O nome da conta não pode estar vazio" },
          { status: 400 },
        );
      }
      if (name.length > MAX_NAME_LEN) {
        return NextResponse.json(
          { error: `O nome da conta deve ter no máximo ${MAX_NAME_LEN} caracteres` },
          { status: 400 },
        );
      }
      update.name = name;
    }

    if ("logo_url" in body) {
      if (body.logo_url !== null && typeof body.logo_url !== "string") {
        return NextResponse.json(
          { error: "O campo 'logo_url' deve ser uma string ou null" },
          { status: 400 },
        );
      }
      update.logo_url = body.logo_url;
    }

    if ("legal_name" in body) {
      if (body.legal_name !== null && typeof body.legal_name !== "string") {
        return NextResponse.json({ error: "O campo 'legal_name' deve ser uma string ou null" }, { status: 400 });
      }
      const legalName = typeof body.legal_name === "string" ? body.legal_name.trim() : null;
      if (legalName && legalName.length > 160) {
        return NextResponse.json({ error: "A razão social deve ter no máximo 160 caracteres" }, { status: 400 });
      }
      update.legal_name = legalName || null;
    }

    if ("cnpj" in body) {
      if (body.cnpj !== null && typeof body.cnpj !== "string") {
        return NextResponse.json({ error: "O campo 'cnpj' deve ser uma string ou null" }, { status: 400 });
      }
      if (body.cnpj === null || body.cnpj.trim() === "") update.cnpj = null;
      else {
        const taxId = validateBrazilianTaxId(body.cnpj);
        if (!taxId || taxId.type !== "cnpj") {
          return NextResponse.json({ error: "Informe um CNPJ válido" }, { status: 400 });
        }
        update.cnpj = taxId.normalized;
      }
    }

    if ("store_address" in body) {
      if (body.store_address !== null && typeof body.store_address !== "string") {
        return NextResponse.json({ error: "O campo 'store_address' deve ser uma string ou null" }, { status: 400 });
      }
      update.store_address = typeof body.store_address === "string" ? body.store_address.trim() || null : null;
    }

    if ("store_lat" in body || "store_lng" in body) {
      const lat = typeof body.store_lat === "number" ? body.store_lat : null;
      const lng = typeof body.store_lng === "number" ? body.store_lng : null;
      if ((lat === null) !== (lng === null)) {
        return NextResponse.json({ error: "Informe latitude e longitude juntas" }, { status: 400 });
      }
      update.store_lat = lat;
      update.store_lng = lng;
    }

    if ("driver_notify_auto_enabled" in body) {
      if (typeof body.driver_notify_auto_enabled !== "boolean") {
        return NextResponse.json({ error: "O campo 'driver_notify_auto_enabled' deve ser booleano" }, { status: 400 });
      }
      update.driver_notify_auto_enabled = body.driver_notify_auto_enabled;
    }

    if ("driver_message_template" in body) {
      if (body.driver_message_template !== null && typeof body.driver_message_template !== "string") {
        return NextResponse.json({ error: "O campo 'driver_message_template' deve ser uma string ou null" }, { status: 400 });
      }
      update.driver_message_template =
        typeof body.driver_message_template === "string" ? body.driver_message_template.trim() || null : null;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nada para atualizar" }, { status: 400 });
    }

    // RLS allows this UPDATE because accounts_update requires
    // `is_account_member(id, 'admin')`, and requireRole already
    // guaranteed the caller is admin+.
    const { data, error } = await ctx.supabase
      .from("accounts")
      .update(update)
      .eq("id", ctx.accountId)
      .select(
        "id, name, logo_url, legal_name, cnpj, store_address, store_lat, store_lng, driver_notify_auto_enabled, driver_message_template",
      )
      .single();

    if (error) {
      console.error("[PATCH /api/account] update error:", error);
      return NextResponse.json(
        { error: "Falha ao atualizar a conta" },
        { status: 500 },
      );
    }

    return NextResponse.json({ account: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
