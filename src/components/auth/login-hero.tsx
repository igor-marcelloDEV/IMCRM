"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image, { type StaticImageData } from "next/image";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";

import { Dialog, DialogContent, DialogClose } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import bgGlow from "../../../public/marketing/login-bg-glow.webp";
import shotInbox from "../../../public/marketing/login-shot-inbox.webp";
import shotPipelines from "../../../public/marketing/login-shot-pipelines.webp";
import shotFlows from "../../../public/marketing/login-shot-flows.webp";
import shotAutomations from "../../../public/marketing/login-shot-automations.webp";
import shotDashboard from "../../../public/marketing/login-shot-dashboard.webp";

interface Slide {
  key: string;
  src: StaticImageData;
  url: string;
}

// Real, screenshotted product — every slide below is an actual page
// from a seeded demo workspace (see CONTRIBUTING.md to recapture).
// Ordered as a pitch: inbox (the daily driver) -> pipeline (where the
// money is tracked) -> flows/automations (what runs on its own) ->
// dashboard (the payoff view of it all working together).
const SLIDES: Slide[] = [
  { key: "inbox", src: shotInbox, url: "crm.imdigitalsolutions.com.br/inbox" },
  { key: "pipelines", src: shotPipelines, url: "crm.imdigitalsolutions.com.br/pipelines" },
  { key: "flows", src: shotFlows, url: "crm.imdigitalsolutions.com.br/flows" },
  { key: "automations", src: shotAutomations, url: "crm.imdigitalsolutions.com.br/automations" },
  { key: "dashboard", src: shotDashboard, url: "crm.imdigitalsolutions.com.br/dashboard" },
];

const AUTOPLAY_MS = 5000;

// Real, screenshotted browser chrome — not a decorative illustration —
// so every slide reads as an actual product, not mockup art.
function BrowserFrame({
  src,
  url,
  onClick,
  enlargeLabel,
  className,
}: {
  src: StaticImageData;
  url: string;
  onClick?: () => void;
  enlargeLabel: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "group/frame relative overflow-hidden rounded-xl border border-white/10 bg-[#0d0d14] shadow-2xl shadow-black/70 ring-1 ring-black/40",
        className,
      )}
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
      <button
        type="button"
        onClick={onClick}
        aria-label={enlargeLabel}
        className="relative block w-full cursor-zoom-in"
      >
        <Image src={src} alt="" className="aspect-[16/10] w-full object-cover object-top" placeholder="blur" />
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover/frame:bg-black/30 group-hover/frame:opacity-100">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm">
            <Maximize2 className="h-4 w-4 text-white" />
          </span>
        </span>
      </button>
    </div>
  );
}

// Real product screenshots (demo workspace, fictitious data) — not
// mockups. See CONTRIBUTING.md if these ever need to be recaptured.
export function LoginHero() {
  const t = useTranslations("LoginPage");
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const goTo = useCallback((next: number) => {
    setIndex((next + SLIDES.length) % SLIDES.length);
  }, []);
  const next = useCallback(() => goTo(index + 1), [goTo, index]);
  const prev = useCallback(() => goTo(index - 1), [goTo, index]);

  // Autoplay — paused on hover and while the lightbox is open so it
  // never fights a visitor who's actually looking at a slide.
  useEffect(() => {
    if (paused || lightboxOpen) return;
    timerRef.current = setInterval(() => {
      setIndex((i) => (i + 1) % SLIDES.length);
    }, AUTOPLAY_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [paused, lightboxOpen, index]);

  // Arrow-key navigation while the lightbox is open.
  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxOpen, next, prev]);

  const slide = SLIDES[index];

  return (
    <div
      className="relative hidden overflow-hidden bg-[#08070c] lg:block"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <Image src={bgGlow} alt="" fill priority className="object-cover opacity-90" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#08070c] via-[#08070c]/35 to-[#08070c]/70" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#08070c] via-transparent to-transparent" />

      <div className="relative flex h-full flex-col justify-center gap-6 p-10 xl:p-14">
        <div className="max-w-lg">
          <h2 className="text-3xl leading-[1.1] font-semibold tracking-tight text-white xl:text-[2.75rem]">
            {t("heroTitle")}
          </h2>
          <p className="mt-4 max-w-md text-base text-white/60">{t("heroSubtitle")}</p>
          <p className="mt-3 max-w-md text-sm text-white/40">{t("heroIntro")}</p>
        </div>

        <div className="relative w-full max-w-xl">
          <BrowserFrame
            src={slide.src}
            url={slide.url}
            onClick={() => setLightboxOpen(true)}
            enlargeLabel={t("carousel.enlarge")}
            className="w-full"
          />

          {/* Prev/next — overlaid on the frame's vertical center. */}
          <button
            type="button"
            onClick={prev}
            aria-label={t("carousel.prev")}
            className="absolute top-1/2 -left-3 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white/80 ring-1 ring-white/10 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={next}
            aria-label={t("carousel.next")}
            className="absolute top-1/2 -right-3 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white/80 ring-1 ring-white/10 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          {/* Per-slide explanation — this is what changes as the
              carousel advances, not just the screenshot. */}
          <div className="mt-4 min-h-[2.75rem]">
            <p className="text-sm font-semibold text-white">{t(`slides.${slide.key}.title`)}</p>
            <p className="mt-0.5 text-xs text-white/50">{t(`slides.${slide.key}.description`)}</p>
          </div>

          <div className="mt-3 flex items-center gap-1.5">
            {SLIDES.map((s, i) => (
              <button
                key={s.key}
                type="button"
                onClick={() => goTo(i)}
                aria-label={t("carousel.goToSlide", { n: i + 1 })}
                aria-current={i === index}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === index ? "w-6 bg-primary" : "w-1.5 bg-white/20 hover:bg-white/40",
                )}
              />
            ))}
          </div>
        </div>
      </div>

      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent
          showCloseButton={false}
          className="max-w-[min(92vw,64rem)] rounded-none border-none bg-transparent p-0 ring-0"
        >
          <div className="relative">
            <BrowserFrame src={slide.src} url={slide.url} enlargeLabel={t("carousel.enlarge")} />
            <p className="mt-4 text-center text-sm font-semibold text-white">
              {t(`slides.${slide.key}.title`)}
            </p>
            <p className="mt-0.5 text-center text-xs text-white/50">
              {t(`slides.${slide.key}.description`)}
            </p>

            <button
              type="button"
              onClick={prev}
              aria-label={t("carousel.prev")}
              className="absolute top-1/2 -left-4 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white/80 ring-1 ring-white/10 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white sm:-left-14"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={next}
              aria-label={t("carousel.next")}
              className="absolute top-1/2 -right-4 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white/80 ring-1 ring-white/10 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white sm:-right-14"
            >
              <ChevronRight className="h-5 w-5" />
            </button>

            <DialogClose
              aria-label={t("carousel.close")}
              className="absolute -top-4 -right-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white/80 ring-1 ring-white/10 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
            >
              <X className="h-4 w-4" />
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
