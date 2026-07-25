import Image, { type StaticImageData } from "next/image";
import { useTranslations } from "next-intl";
import { Inbox, Workflow, Zap } from "lucide-react";

import bgGlow from "../../../public/marketing/login-bg-glow.webp";
import shotInbox from "../../../public/marketing/login-shot-inbox.webp";
import shotDashboard from "../../../public/marketing/login-shot-dashboard.webp";

const bullets = [
  { key: "heroBullet1", icon: Inbox },
  { key: "heroBullet2", icon: Workflow },
  { key: "heroBullet3", icon: Zap },
] as const;

// Real, screenshotted browser chrome — not a decorative illustration —
// so the two screenshots below read as an actual product, not mockup art.
function BrowserFrame({
  src,
  url,
  className,
}: {
  src: StaticImageData;
  url: string;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-white/10 bg-[#0d0d14] shadow-2xl shadow-black/70 ring-1 ring-black/40 ${className ?? ""}`}
    >
      <div className="flex items-center gap-2 border-b border-white/5 bg-white/[0.03] px-3 py-2">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="ml-2 flex-1 truncate rounded-md bg-white/5 px-2.5 py-1 text-center text-[10px] text-white/40">
          {url}
        </div>
      </div>
      <Image src={src} alt="" className="aspect-[16/10] w-full object-cover object-top" placeholder="blur" />
    </div>
  );
}

// Real product screenshots (demo workspace, fictitious data) — not
// mockups. See CONTRIBUTING.md if these ever need to be recaptured.
export function LoginHero() {
  const t = useTranslations("LoginPage");

  return (
    <div className="relative hidden overflow-hidden bg-[#08070c] lg:block">
      <Image src={bgGlow} alt="" fill priority className="object-cover opacity-90" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#08070c] via-[#08070c]/35 to-[#08070c]/70" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#08070c] via-transparent to-transparent" />

      <div className="relative flex h-full flex-col justify-center gap-10 p-10 xl:p-14">
        <div className="max-w-lg">
          <h2 className="text-3xl leading-[1.1] font-semibold tracking-tight text-white xl:text-[2.75rem]">
            {t("heroTitle")}
          </h2>
          <p className="mt-4 max-w-md text-base text-white/60">{t("heroSubtitle")}</p>

          <ul className="mt-8 flex flex-col gap-3">
            {bullets.map(({ key, icon: Icon }) => (
              <li key={key} className="flex items-center gap-3 text-sm text-white/80">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
                  <Icon className="h-4 w-4 text-white" />
                </span>
                {t(key)}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative w-full max-w-xl">
          <BrowserFrame
            src={shotDashboard}
            url="crm.imdigitalsolutions.com.br"
            className="w-full -rotate-1"
          />
          <BrowserFrame
            src={shotInbox}
            url="crm.imdigitalsolutions.com.br/inbox"
            className="absolute -right-6 -bottom-10 w-[52%] rotate-2 xl:-right-10"
          />
        </div>
      </div>
    </div>
  );
}
