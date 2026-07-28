"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ImageIcon,
  Loader2,
  Package,
  Pencil,
  Plus,
  Sparkles,
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
  };
}

export function CatalogManager() {
  const t = useTranslations("Settings.catalog");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);

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

    const payload = {
      name: draft.name,
      description: draft.description,
      price_cents: Math.round(priceReais * 100),
      media_url: draft.media_url || null,
      media_type: draft.media_url ? draft.media_type : null,
      is_upsell: draft.is_upsell,
      is_active: draft.is_active,
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
        const { publicUrl } = await uploadAccountMedia(CATALOG_MEDIA_BUCKET, file);
        onChange({ media_url: publicUrl, media_type: detectedKind });
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
