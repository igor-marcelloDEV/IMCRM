"use client";

import { Suspense, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  BarChart3,
  Bot,
  Check,
  MessageSquare,
  PackageCheck,
  ShieldCheck,
  UsersRound,
  Workflow,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import dashboardShot from "../../../../public/marketing/login-shot-dashboard.webp";

const benefits = [
  {
    icon: MessageSquare,
    title: "Atendimento sem conversa perdida",
    description: "Centralize o WhatsApp da equipe, distribua atendimentos e mantenha todo o histórico do cliente.",
  },
  {
    icon: Workflow,
    title: "Vendas organizadas em funis",
    description: "Acompanhe cada oportunidade e pedido, do primeiro contato até o pagamento e a entrega.",
  },
  {
    icon: Bot,
    title: "Automação que trabalha por você",
    description: "Responda, qualifique e recupere clientes automaticamente, sem deixar o atendimento impessoal.",
  },
];

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("invite");
  const authError = searchParams.get("auth_error");
  const t = useTranslations("LoginPage");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    authError ? "Não foi possível concluir o acesso com o Google. Tente novamente." : null,
  );
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const supabase = createClient();

  const signupHref = inviteToken
    ? `/signup?invite=${encodeURIComponent(inviteToken)}`
    : "/signup";

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
    if (loginError) {
      setError(loginError.message);
      setLoading(false);
      return;
    }

    window.location.href = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/today";
  };

  const handleGoogleLogin = async () => {
    setError(null);
    setGoogleLoading(true);
    const destination = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/today";
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(destination)}`;
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: {
          access_type: "offline",
          prompt: "select_account",
        },
      },
    });

    if (oauthError) {
      setError(oauthError.message);
      setGoogleLoading(false);
    }
  };

  return (
    <main className="relative min-h-screen w-full max-w-full overflow-x-clip bg-[#05070a] text-white">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[760px] bg-[radial-gradient(circle_at_20%_20%,rgba(0,132,255,.22),transparent_38%),radial-gradient(circle_at_80%_10%,rgba(28,79,255,.12),transparent_35%)]" />

      <header className="relative z-20 border-b border-white/10 bg-[#05070a]/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-8">
          <Link href="/login" className="flex items-center gap-2.5" aria-label="IM CRM">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#0787f6] shadow-lg shadow-blue-500/20">
              <MessageSquare className="h-5 w-5" />
            </span>
            <span className="text-base font-bold tracking-tight">IM <span className="text-[#249aff]">CRM</span></span>
          </Link>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-sm text-white/55 sm:inline">Ainda não usa o IM CRM?</span>
            <Link href={signupHref} className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-xl border border-blue-400/30 bg-[#0787f6] px-4 text-sm font-semibold text-white shadow-lg shadow-blue-500/15 transition duration-200 hover:-translate-y-0.5 hover:bg-[#1994ff] hover:shadow-blue-500/25 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#05070a]">Criar conta</Link>
          </div>
        </div>
      </header>

      <section className="relative mx-auto grid w-full max-w-7xl items-center gap-10 px-4 py-12 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,.85fr)] lg:gap-16 lg:py-24">
        <div className="min-w-0">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-blue-400/20 bg-blue-400/10 px-3 py-1.5 text-xs font-medium text-blue-300">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
            Atendimento, vendas e pedidos em um só lugar
          </div>
          <h1 className="max-w-3xl text-[clamp(2.25rem,8vw,3.75rem)] leading-[1.05] font-black tracking-[-0.04em] break-words">
            Transforme conversas no WhatsApp em <span className="text-[#249aff]">vendas organizadas.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-white/60 sm:text-lg">
            O IM CRM reúne sua equipe, clientes, funis, pagamentos e entregas em uma única operação — para você vender mais e perder menos oportunidades.
          </p>
          <div className="mt-7 grid gap-3 text-sm text-white/75 sm:grid-cols-2">
            {["Caixa de entrada compartilhada", "Funil de vendas e pedidos", "Automações e agentes de IA", "Indicadores em tempo real"].map((item) => (
              <div key={item} className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-400"><Check className="h-3.5 w-3.5" /></span>
                {item}
              </div>
            ))}
          </div>
          <div className="mt-9 flex flex-wrap gap-4 text-xs text-white/45">
            <span className="flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-blue-400" /> Dados protegidos</span>
            <span className="flex items-center gap-1.5"><UsersRound className="h-4 w-4 text-blue-400" /> Feito para equipes</span>
            <span className="flex items-center gap-1.5"><PackageCheck className="h-4 w-4 text-blue-400" /> Da venda à entrega</span>
          </div>
        </div>

        <div id="entrar" className="relative min-w-0 scroll-mt-24">
          <div className="absolute -inset-1 rounded-[28px] bg-gradient-to-br from-blue-500/30 to-transparent blur-xl" />
          <div className="relative rounded-2xl border border-white/10 bg-[#10141a]/95 p-6 shadow-2xl shadow-black/40 sm:p-8">
            <div className="mb-7">
              <p className="text-xs font-semibold tracking-[.16em] text-[#249aff] uppercase">Acesso ao sistema</p>
              <h2 className="mt-2 text-2xl font-bold">{inviteToken ? t("titleAccept") : t("titleWelcome")}</h2>
              <p className="mt-1.5 text-sm text-white/50">{inviteToken ? t("descAccept") : "Entre para continuar seus atendimentos."}</p>
            </div>
            <form onSubmit={handleLogin} className="space-y-4">
              {error && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}
              <div className="space-y-2">
                <Label htmlFor="email" className="text-white/70">{t("emailLabel")}</Label>
                <Input id="email" type="email" autoComplete="email" placeholder={t("emailPlaceholder")} value={email} onChange={(event) => setEmail(event.target.value)} required className="h-11 border-white/10 bg-white/[.04] text-white placeholder:text-white/25 focus-visible:border-blue-500" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-white/70">{t("passwordLabel")}</Label>
                  <Link href="/forgot-password" className="text-xs text-[#249aff] hover:underline">{t("forgotPassword")}</Link>
                </div>
                <Input id="password" type="password" autoComplete="current-password" placeholder={t("passwordPlaceholder")} value={password} onChange={(event) => setPassword(event.target.value)} required className="h-11 border-white/10 bg-white/[.04] text-white placeholder:text-white/25 focus-visible:border-blue-500" />
              </div>
              <Button type="submit" disabled={loading} className="min-h-12 w-full rounded-xl border border-blue-400/30 !bg-[#0787f6] px-5 text-base font-bold !text-white shadow-lg shadow-blue-500/20 transition duration-200 hover:-translate-y-0.5 hover:!bg-[#1994ff] hover:shadow-blue-500/30 active:translate-y-0 disabled:translate-y-0 disabled:shadow-none">
                {loading ? t("signingIn") : t("signIn")} {!loading && <ArrowRight className="ml-1 h-4 w-4" />}
              </Button>
            </form>
            <div className="my-5 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-white/10" />
              <span className="text-[11px] font-medium tracking-wider text-white/30 uppercase">ou continue com</span>
              <span className="h-px flex-1 bg-white/10" />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={googleLoading || loading}
              onClick={handleGoogleLogin}
              className="min-h-12 w-full rounded-xl border border-white/20 !bg-white px-5 text-sm font-semibold !text-[#202124] shadow-md transition duration-200 hover:-translate-y-0.5 hover:!bg-[#f3f6fb] hover:shadow-lg hover:!text-[#202124] active:translate-y-0 disabled:translate-y-0"
            >
              <GoogleIcon />
              {googleLoading ? "Conectando ao Google..." : "Entrar com Google"}
            </Button>
            <div className="my-6 h-px bg-white/10" />
            <p className="text-center text-sm text-white/50">{t("noAccount")} <Link href={signupHref} className="font-medium text-[#249aff] hover:underline">{t("createAccount")}</Link></p>
          </div>
        </div>
      </section>

      {!inviteToken && (
        <>
          <section className="relative border-y border-white/10 bg-white/[.025]">
            <div className="mx-auto grid max-w-7xl gap-px px-5 py-8 text-center sm:grid-cols-3 sm:px-8">
              {[{ value: "1 painel", label: "para toda a operação" }, { value: "24 horas", label: "de automações ativas" }, { value: "100%", label: "do histórico centralizado" }].map((stat) => (
                <div key={stat.value} className="py-4"><strong className="text-2xl text-white">{stat.value}</strong><p className="mt-1 text-sm text-white/40">{stat.label}</p></div>
              ))}
            </div>
          </section>

          <section className="relative mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:py-28">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-sm font-semibold text-[#249aff]">OPERAÇÃO COMPLETA</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Tudo o que sua equipe precisa para atender e vender melhor</h2>
              <p className="mt-4 text-white/50">Menos abas, menos planilhas e mais clareza sobre cada cliente.</p>
            </div>
            <div className="mt-12 grid gap-5 md:grid-cols-3">
              {benefits.map(({ icon: Icon, title, description }) => (
                <article key={title} className="rounded-2xl border border-white/10 bg-[#0d1117] p-6 transition-transform hover:-translate-y-1">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-500/10 text-[#249aff]"><Icon className="h-5 w-5" /></span>
                  <h3 className="mt-5 text-lg font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-white/50">{description}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="relative mx-auto max-w-7xl px-5 pb-20 sm:px-8 lg:pb-28">
            <div className="overflow-hidden rounded-3xl border border-white/10 bg-[#0d1117] p-4 shadow-2xl shadow-blue-950/20 sm:p-7">
              <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                <div><p className="flex items-center gap-2 text-sm font-semibold text-[#249aff]"><BarChart3 className="h-4 w-4" /> VISÃO DO NEGÓCIO</p><h2 className="mt-2 text-2xl font-bold sm:text-3xl">Decida com dados, não com suposições.</h2></div>
                <p className="max-w-md text-sm leading-6 text-white/45">Veja atendimentos, oportunidades, pedidos e resultados em tempo real.</p>
              </div>
              <div className="overflow-hidden rounded-xl border border-white/10 bg-black">
                <Image src={dashboardShot} alt="Painel de resultados do IM CRM" className="h-auto w-full" priority />
              </div>
            </div>
          </section>

          <section className="relative w-full overflow-hidden border-t border-white/10 bg-[#0787f6]">
            <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-white/10" />
            <div className="relative mx-auto grid w-full max-w-7xl grid-cols-1 items-center gap-6 px-4 py-12 text-center sm:px-8 sm:py-14 lg:grid-cols-[minmax(0,1fr)_auto] lg:text-left">
              <div className="min-w-0"><h2 className="text-2xl leading-tight font-bold break-words sm:text-3xl">Pronto para organizar sua operação?</h2><p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-white/80 lg:mx-0">Crie sua conta e transforme cada conversa em uma oportunidade acompanhada.</p></div>
              <Link href="/signup" className="mx-auto inline-flex min-h-12 w-full max-w-xs shrink-0 items-center justify-center gap-2 rounded-xl border border-white/70 !bg-white px-6 text-base font-bold !text-[#076dc4] shadow-xl shadow-blue-950/20 transition duration-200 hover:-translate-y-0.5 hover:!bg-blue-50 hover:!text-[#045ba7] hover:shadow-2xl active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0787f6] sm:w-auto lg:mx-0">Começar agora <ArrowRight className="h-4 w-4" /></Link>
            </div>
          </section>
        </>
      )}

      <footer className="w-full border-t border-white/10 bg-[#05070a] px-4 py-7 text-center text-xs leading-5 text-white/35">© {new Date().getFullYear()} IM Digital Solutions. Atendimento e vendas conectados.</footer>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.63-2.43l-3.24-2.53c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.61A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.39 13.87A6.02 6.02 0 0 1 6.08 12c0-.65.11-1.28.31-1.87V7.52H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.48l3.35-2.61Z" />
      <path fill="#EA4335" d="M12 6c1.47 0 2.79.51 3.83 1.5l2.87-2.87A9.63 9.63 0 0 0 12 2a10 10 0 0 0-8.96 5.52l3.35 2.61C7.18 7.76 9.39 6 12 6Z" />
    </svg>
  );
}
