import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/billing/admin-client";
import {
  claimTrial,
  createTrialClaimRepository,
  previewTrialClaim,
} from "@/lib/billing/trial-claim";

const HTML_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
} as const;

function destination(request: Request, pathname: "/billing" | "/login") {
  const fallback = new URL(pathname, request.url);
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!configuredSiteUrl) return fallback;

  try {
    const url = new URL(configuredSiteUrl);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return fallback;
  }
}

function redirectTo(request: Request, pathname: "/billing" | "/login") {
  return NextResponse.redirect(destination(request, pathname), 303);
}

function confirmationPage(token: string) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ativar teste grátis</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; }
      body { align-items: center; background: #f6f7f9; display: flex; margin: 0; min-height: 100vh; padding: 24px; }
      main { background: white; border: 1px solid #e5e7eb; border-radius: 16px; box-shadow: 0 12px 32px rgb(0 0 0 / 8%); margin: auto; max-width: 440px; padding: 32px; }
      h1 { font-size: 1.5rem; margin: 0 0 12px; }
      p { color: #4b5563; line-height: 1.55; margin: 0 0 24px; }
      button { background: #111827; border: 0; border-radius: 10px; color: white; cursor: pointer; font: inherit; font-weight: 650; padding: 12px 18px; width: 100%; }
    </style>
  </head>
  <body>
    <main>
      <h1>Seu teste grátis está pronto</h1>
      <p>Confirme para ativar 7 dias de acesso. Esta página ainda não altera sua assinatura.</p>
      <form method="post" action="/api/billing/claim-trial">
        <input type="hidden" name="token" value="${token}">
        <button type="submit">Ativar meu teste grátis</button>
      </form>
    </main>
  </body>
</html>`;
}

async function requestToken(request: Request): Promise<string | null> {
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = (await request.json()) as { token?: unknown };
      return typeof body.token === "string" ? body.token : null;
    }

    const token = (await request.formData()).get("token");
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

/**
 * The public WhatsApp link is intentionally read-only. It validates the
 * bearer token and renders an explicit POST confirmation, so link scanners
 * and browser prefetchers cannot provision a subscription.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");

  try {
    const repository = createTrialClaimRepository(supabaseAdmin());
    const preview = await previewTrialClaim(repository, token);

    if (preview === "claimable" && token) {
      return new Response(confirmationPage(token), {
        status: 200,
        headers: HTML_HEADERS,
      });
    }

    return redirectTo(
      request,
      preview === "already_claimed" || preview === "already_subscribed"
        ? "/login"
        : "/billing",
    );
  } catch (error) {
    console.error("[billing claim-trial] preview failed", error);
    return new Response("Não foi possível verificar o teste agora.", {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
}

/**
 * The state-changing operation is idempotent in `claimTrial`: replays,
 * existing subscriptions and concurrent unique-key conflicts never create
 * a second trial.
 */
export async function POST(request: Request) {
  const token = await requestToken(request);

  try {
    const repository = createTrialClaimRepository(supabaseAdmin());
    const result = await claimTrial(repository, token);

    if (
      result === "claimed" ||
      result === "already_claimed" ||
      result === "already_subscribed"
    ) {
      return redirectTo(request, "/login");
    }

    return redirectTo(request, "/billing");
  } catch (error) {
    console.error("[billing claim-trial] claim failed", error);
    return new Response("Não foi possível ativar o teste agora.", {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
}
