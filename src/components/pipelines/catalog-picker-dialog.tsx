"use client";

import { useMemo, useState } from "react";
import { formatCurrency } from "@/lib/currency";
import type { CatalogItem } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Package, Loader2, Plus } from "lucide-react";
import { useTranslations } from "next-intl";

interface CatalogPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CatalogItem[];
  currency: string;
  busy: boolean;
  /** Receives the full item (not just its id) so the caller can branch
   *  on `addon_groups` before deciding to add it directly or open a
   *  configuration step first. */
  onPick: (item: CatalogItem) => void;
}

/**
 * Full-size product/service picker — opened from the deal panel's
 * "Adicionar item" button instead of the old cramped inline dropdown,
 * so a catalog with dozens of items is actually browsable (search +
 * a real grid with photos) rather than a tiny scrolling <select>.
 */
export function CatalogPickerDialog({
  open,
  onOpenChange,
  items,
  currency,
  busy,
  onPick,
}: CatalogPickerDialogProps) {
  const t = useTranslations("Pipelines.form.items");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        (i.description ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[95vw] max-w-3xl flex-col p-0 sm:h-[80vh]">
        <DialogHeader className="border-b border-border px-5 pt-5 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-4 w-4 text-primary" />
            {t("pickerTitle")}
          </DialogTitle>
          <DialogDescription>{t("pickerDesc")}</DialogDescription>
          <div className="relative mt-2">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("pickerSearchPlaceholder")}
              className="bg-muted pl-8"
            />
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {filtered.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {items.length === 0 ? t("pickerAllAdded") : t("pickerNoResults")}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(item)}
                  className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-primary/50 hover:bg-muted/50 disabled:opacity-50"
                >
                  <div className="flex aspect-square items-center justify-center bg-muted">
                    {item.media_url && item.media_type === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.media_url}
                        alt={item.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Package className="h-8 w-8 text-muted-foreground/50" />
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1 p-2.5">
                    <p className="line-clamp-2 text-xs font-medium text-foreground">
                      {item.name}
                    </p>
                    <div className="mt-auto flex items-center justify-between gap-1 pt-1">
                      <span className="text-xs font-semibold text-primary">
                        {formatCurrency(item.price_cents / 100, currency)}
                      </span>
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary opacity-0 transition-opacity group-hover:opacity-100">
                        <Plus className="h-3 w-3" />
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {busy && (
          <div className="flex items-center justify-center gap-2 border-t border-border px-5 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> {t("pickerAdding")}
          </div>
        )}

        <div className="border-t border-border px-5 py-3">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => onOpenChange(false)}
          >
            {t("pickerClose")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
