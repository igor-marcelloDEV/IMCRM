import Image from "next/image";
import { useTranslations } from "next-intl";
import { Inbox, Workflow, Zap } from "lucide-react";

import bgGlow from "../../../public/marketing/login-bg-glow.webp";
import shotInbox from "../../../public/marketing/login-shot-inbox.webp";
import shotPipelines from "../../../public/marketing/login-shot-pipelines.webp";
import shotDashboard from "../../../public/marketing/login-shot-dashboard.webp";

const bullets = [
  { key: "heroBullet1", icon: Inbox },
  { key: "heroBullet2", icon: Workflow },
  { key: "heroBullet3", icon: Zap },
] as const;

// Real product screenshots (demo workspace, fictitious data) — not
// mockups. See CONTRIBUTING.md if these ever need to be recaptured.
export function LoginHero() {
  const t = useTranslations("LoginPage");

  return (
    <div className="relative hidden overflow-hidden bg-[#08070c] lg:block">
      <Image
        src={bgGlow}
        alt=""
        fill
        priority
        className="object-cover opacity-90"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-[#08070c] via-[#08070c]/30 to-[#08070c]/60" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#08070c] via-transparent to-transparent" />

      <div className="relative flex h-full flex-col justify-between p-10 xl:p-14">
        <div className="max-w-md">
          <h2 className="text-2xl font-semibold text-white xl:text-3xl">
            {t("heroTitle")}
          </h2>
          <p className="mt-3 text-sm text-white/60 xl:text-base">
            {t("heroSubtitle")}
          </p>

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

        <div className="relative mx-auto h-[340px] w-full max-w-lg xl:h-[400px]">
          <div className="absolute top-6 right-0 w-[62%] rotate-[2.5deg] overflow-hidden rounded-xl border border-white/10 shadow-2xl shadow-black/60 ring-1 ring-black/20">
            <Image
              src={shotInbox}
              alt=""
              className="aspect-[16/10] w-full object-cover object-top"
              placeholder="blur"
            />
          </div>
          <div className="absolute top-0 left-0 z-10 w-[68%] -rotate-2 overflow-hidden rounded-xl border border-white/10 shadow-2xl shadow-black/60 ring-1 ring-black/20">
            <Image
              src={shotDashboard}
              alt=""
              className="aspect-[16/10] w-full object-cover object-top"
              placeholder="blur"
            />
          </div>
          <div className="absolute bottom-0 left-[18%] z-20 w-[58%] rotate-[-3deg] overflow-hidden rounded-xl border border-white/10 shadow-2xl shadow-black/60 ring-1 ring-black/20">
            <Image
              src={shotPipelines}
              alt=""
              className="aspect-[16/10] w-full object-cover object-top"
              placeholder="blur"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
