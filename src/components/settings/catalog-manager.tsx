"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Check,
  Copy,
  ImageIcon,
  Loader2,
  Package,
  Pencil,
  Plus,
  Sparkles,
  Store,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsPanelHead } from "./settings-panel-head";
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from "@/lib/storage/upload-media";
import { formatCurrency } from "@/lib/currency";
import type { CatalogItem } from "@/types";

const CATALOG_MEDIA_BUCKET = "flow-media";
const MEDIA_ACCEPT: Record<"image" | "video", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
};

interface DraftState {
  id?: string;
  name: string;
  description: string;
  price: string; // reais, as typed — converted to cents on save
  media_url: string;
  media_type: "image" | "video" | null;
  is_upsell: boolean;
  is_active: boolean;
  stock: string; // integer, as typed — empty means "not tracked" (unlimited)
  offer_type: 'physical_product' | 'service' | 'subscription';
  billing_cycle: 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUALLY' | 'YEARLY';
  compare_at_price: string;
  trial_days: string;
  campaign_badge: string;
  sku: string;
  ncm: string;
  cest: string;
  cfop: string;
  fiscal_unit: string;
}

function emptyDraft(): DraftState {
  return {
    name: "",
    description: "",
    price: "",
    media_url: "",
    media_type: null,
    is_upsell: false,
    is_active: true,
    stock: "",
    offer_type: 'service', billing_cycle: 'MONTHLY', compare_at_price: '', trial_days: '0', campaign_badge: '', sku: '', ncm: '', cest: '', cfop: '', fiscal_unit: 'UN',
  };
}

function toDraft(item: CatalogItem): DraftState {
  return {
    id: item.id,
    name: item.name,
    description: item.description ?? "",
    price: (item.price_cents / 100).toFixed(2),
    media_url: item.media_url ?? "",
    media_type: item.media_type,
    is_upsell: item.is_upsell,
    is_active: item.is_active,
    stock: item.stock_quantity === null ? "" : String(item.stock_quantity),
    offer_type: item.offer_type ?? 'service', billing_cycle: item.billing_cycle ?? 'MONTHLY', compare_at_price: item.compare_at_price_cents ? (item.compare_at_price_cents / 100).toFixed(2) : '', trial_days: String(item.trial_days ?? 0), campaign_badge: item.campaign_badge ?? '', sku: item.sku ?? '', ncm: item.ncm ?? '', cest: item.cest ?? '', cfop: item.cfop ?? '', fiscal_unit: item.fiscal_unit ?? 'UN',
  };
}

export function CatalogManager() {
  const t = useTranslations("Settings.catalog");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [storeSlug, setStoreSlug] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/catalog", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data.catalog_items as CatalogItem[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetch("/api/account", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        setAccountId(data?.account?.id ?? null);
        setStoreSlug(data?.account?.store_slug ?? null);
      })
      .catch(() => {});
  }, []);

  const storeUrl =
    accountId && typeof window !== "undefined"
      ? `${window.location.origin}/loja/${storeSlug || accountId}`
      : null;

  const copyStoreUrl = useCallback(() => {
    if (!storeUrl) return;
    void navigator.clipboard.writeText(storeUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [storeUrl]);

  const openCreate = () => setDraft(emptyDraft());
  const openEdit = (item: CatalogItem) => setDraft(toDraft(item));

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error(t("toastNameRequired"));
      return;
    }
    const priceReais = Number(draft.price.replace(",", "."));
    if (!Number.isFinite(priceReais) || priceReais < 0) {
      toast.error(t("toastPriceInvalid"));
      return;
    }

    let stockQuantity: number | null = null;
    if (draft.stock.trim() !== "") {
      const parsed = Number(draft.stock);
      if (!Number.isInteger(parsed) || parsed < 0) {
        toast.error(t("toastStockInvalid"));
        return;
      }
      stockQuantity = parsed;
    }

    const payload = {
      name: draft.name,
      description: draft.description,
      price_cents: Math.round(priceReais * 100),
      media_url: draft.media_url || null,
      media_type: draft.media_url ? draft.media_type : null,
      is_upsell: draft.is_upsell,
      is_active: draft.is_active,
      stock_quantity: stockQuantity,
      offer_type: draft.offer_type,
      billing_cycle: draft.offer_type === 'subscription' ? draft.billing_cycle : null,
      compare_at_price_cents: draft.compare_at_price ? Math.round(Number(draft.compare_at_price.replace(',', '.')) * 100) : null,
      trial_days: draft.offer_type === 'subscription' ? Number(draft.trial_days) || 0 : 0,
      campaign_badge: draft.campaign_badge || null,
      sku: draft.sku || null, ncm: draft.ncm || null, cest: draft.cest || null, cfop: draft.cfop || null, fiscal_unit: draft.fiscal_unit || 'UN',
    };

    setSaving(true);
    try {
      const res = await fetch(
        draft.id ? `/api/catalog/${draft.id}` : "/api/catalog",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("toastSaveFailed"));
        return;
      }
      toast.success(draft.id ? t("toastUpdated") : t("toastCreated"));
      setDraft(null);
      await load();
    } catch {
      toast.error(t("toastSaveFailed"));
    } finally {
      setSaving(false);
    }
  }, [draft, load, t]);

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm(t("deleteConfirm"))) return;
      const res = await fetch(`/api/catalog/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(t("toastDeleteFailed"));
        return;
      }
      await load();
    },
    [load, t],
  );

  return (
    <div>
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
        action={
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            {t("newItem")}
          </Button>
        }
      />

      {storeUrl && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-muted/50 p-3">
          <Store className="h-4 w-4 shrink-0 text-cyan-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{t("storeLinkTitle")}</p>
            <p className="truncate text-xs text-muted-foreground" title={storeUrl}>{storeUrl}</p>
          </div>
          <Button variant="outline" size="sm" onClick={copyStoreUrl} className="shrink-0">
            {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
            {copied ? t("storeLinkCopied") : t("storeLinkCopy")}
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
            >
              {item.media_url ? (
                item.media_type === "video" ? (
                  <video src={item.media_url} className="h-12 w-12 shrink-0 rounded-md object-cover" muted />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.media_url} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />
                )
              ) : (
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Package className="h-5 w-5" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
                  {item.is_upsell && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                      <Sparkles className="h-2.5 w-2.5" />
                      {t("upsellBadge")}
                    </span>
                  )}
                  {!item.is_active && (
                    <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {t("inactiveBadge")}
                    </span>
                  )}
                  {item.stock_quantity !== null && item.stock_quantity <= 0 && (
                    <span className="rounded-full border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
                      {t("outOfStockBadge")}
                    </span>
                  )}
                  {item.stock_quantity !== null && item.stock_quantity > 0 && (
                    <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {t("stockBadge", { count: item.stock_quantity })}
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {formatCurrency(item.price_cents / 100, item.currency)}
                  {item.description ? ` · ${item.description}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => openEdit(item)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => remove(item.id)}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("editTitle") : t("newTitle")}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="max-h-[70vh] space-y-3 overflow-y-auto">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">{t("nameLabel")}</label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t("namePlaceholder")}
                  className="bg-muted text-foreground"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">{t("descriptionLabel")}</label>
                <Textarea
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder={t("descriptionPlaceholder")}
                  className="min-h-20 bg-muted text-foreground"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="mb-1 block text-xs text-muted-foreground">Tipo de oferta</label><select className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-sm" value={draft.offer_type} onChange={(e) => setDraft({ ...draft, offer_type: e.target.value as DraftState['offer_type'] })}><option value="service">Serviço</option><option value="physical_product">Produto físico</option><option value="subscription">Plano por assinatura</option></select></div>
                {draft.offer_type === 'subscription' && <div><label className="mb-1 block text-xs text-muted-foreground">Periodicidade</label><select className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-sm" value={draft.billing_cycle} onChange={(e) => setDraft({ ...draft, billing_cycle: e.target.value as DraftState['billing_cycle'] })}><option value="MONTHLY">Mensal</option><option value="QUARTERLY">Trimestral</option><option value="SEMIANNUALLY">Semestral</option><option value="YEARLY">Anual</option></select></div>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">{t("priceLabel")}</label>
                  <Input
                    value={draft.price}
                    onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                    placeholder="0,00"
                    inputMode="decimal"
                    className="bg-muted text-foreground"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">{t("stockLabel")}</label>
                  <Input
                    value={draft.stock}
                    onChange={(e) => setDraft({ ...draft, stock: e.target.value })}
                    placeholder={t("stockPlaceholder")}
                    inputMode="numeric"
                    className="bg-muted text-foreground"
                  />
                </div>
              </div>
              <p className="-mt-2 text-xs text-muted-foreground">{t("stockHint")}</p>
              <div className="grid grid-cols-2 gap-3"><div><label className="mb-1 block text-xs text-muted-foreground">Preço original</label><Input value={draft.compare_at_price} onChange={(e) => setDraft({ ...draft, compare_at_price: e.target.value })} placeholder="Para mostrar desconto" /></div><div><label className="mb-1 block text-xs text-muted-foreground">Selo da campanha</label><Input value={draft.campaign_badge} onChange={(e) => setDraft({ ...draft, campaign_badge: e.target.value })} placeholder="Mais vendido" maxLength={40} /></div></div>
              {draft.offer_type === 'subscription' && <div><label className="mb-1 block text-xs text-muted-foreground">Dias de teste grátis</label><Input type="number" min={0} max={365} value={draft.trial_days} onChange={(e) => setDraft({ ...draft, trial_days: e.target.value })} /></div>}
              {draft.offer_type === 'physical_product' && <div className="rounded-lg border border-border p-3"><p className="mb-3 text-sm font-medium">Dados fiscais da mercadoria</p><div className="grid grid-cols-2 gap-3"><Input value={draft.sku} onChange={(e) => setDraft({ ...draft, sku: e.target.value })} placeholder="SKU" /><Input value={draft.ncm} onChange={(e) => setDraft({ ...draft, ncm: e.target.value })} placeholder="NCM (8 dígitos)" /><Input value={draft.cest} onChange={(e) => setDraft({ ...draft, cest: e.target.value })} placeholder="CEST" /><Input value={draft.cfop} onChange={(e) => setDraft({ ...draft, cfop: e.target.value })} placeholder="CFOP" /><Input value={draft.fiscal_unit} onChange={(e) => setDraft({ ...draft, fiscal_unit: e.target.value })} placeholder="Unidade (UN)" /></div><p className="mt-2 text-xs text-amber-400">Valide NCM, CEST e CFOP com sua contabilidade.</p></div>}

              <MediaField draft={draft} onChange={(patch) => setDraft({ ...draft, ...patch })} t={t} />

              <div className="flex items-center justify-between rounded-md border border-border bg-muted/50 px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">{t("upsellLabel")}</p>
                  <p className="text-xs text-muted-foreground">{t("upsellHint")}</p>
                </div>
                <Switch
                  checked={draft.is_upsell}
                  onCheckedChange={(v) => setDraft({ ...draft, is_upsell: v })}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/50 px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">{t("activeLabel")}</p>
                  <p className="text-xs text-muted-foreground">{t("activeHint")}</p>
                </div>
                <Switch
                  checked={draft.is_active}
                  onCheckedChange={(v) => setDraft({ ...draft, is_active: v })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MediaField({
  draft,
  onChange,
  t,
}: {
  draft: DraftState;
  onChange: (patch: Partial<DraftState>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const kind = draft.media_type ?? "image";

  const handleFile = useCallback(
    async (file: File) => {
      const isVideo = file.type.startsWith("video/");
      const detectedKind: "image" | "video" = isVideo ? "video" : "image";
      const limit = MEDIA_MAX_BYTES_BY_KIND[detectedKind];
      if (file.size > limit) {
        toast.error(t("toastMediaFileTooLarge", { size: (file.size / 1024 / 1024).toFixed(1) }));
        return;
      }
      setUploading(true);
      try {
        const { url } = await uploadAccountMedia(CATALOG_MEDIA_BUCKET, file);
        onChange({ media_url: url, media_type: detectedKind });
        toast.success(t("fileUploaded"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : t("toastUploadFailed");
        toast.error(msg);
      } finally {
        setUploading(false);
      }
    },
    [onChange, t],
  );

  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{t("mediaLabel")}</label>
      {draft.media_url ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
          {kind === "video" ? (
            <Video className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
          ) : (
            <ImageIcon className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
          )}
          <a
            href={draft.media_url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 truncate text-foreground hover:text-cyan-300"
            title={draft.media_url}
          >
            {draft.media_url.split("/").pop()}
          </a>
          <button
            type="button"
            onClick={() => onChange({ media_url: "", media_type: null })}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("removeFile")}
            disabled={uploading}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {uploading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("uploading")}
            </>
          ) : (
            <>
              <Upload className="h-3.5 w-3.5" />
              {t("clickToUpload")}
            </>
          )}
        </button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={`${MEDIA_ACCEPT.image},${MEDIA_ACCEPT.video}`}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
