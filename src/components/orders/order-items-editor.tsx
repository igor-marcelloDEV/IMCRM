"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/currency";
import type { CatalogItem, OrderItem } from "@/types";
import { Button } from "@/components/ui/button";
import { Minus, Plus, Settings2, Trash2 } from "lucide-react";
import { CatalogPickerDialog } from "@/components/pipelines/catalog-picker-dialog";
import { AddonsPickerDialog, type AddonSelection } from "@/components/orders/addons-picker-dialog";
import { queueableFetch } from "@/lib/offline/outbox";

interface OrderItemsEditorProps {
  items: OrderItem[];
  catalogItems: CatalogItem[];
  currency: string;
  /** Whether quantity/add-ons can still change (e.g. order still pending_payment). */
  editable: boolean;
  /** Base path for this order's items, e.g. `/api/orders/${id}/items` or `/api/deals/${id}/items`. */
  itemsEndpoint: string;
  onItemsChange: (items: OrderItem[]) => void;
  /** Rendered when there's nothing addable and the list is empty (e.g. "catalog is empty, go add products"). */
  emptyCatalogSlot?: React.ReactNode;
}

/** Shared item list + picker used by both the internal deal panel and
 *  the comanda detail sheet — extracted so add-ons logic (picker,
 *  apply-to-all, per-line edit) lives in exactly one place instead of
 *  tripling across surfaces. */
export function OrderItemsEditor({
  items,
  catalogItems,
  currency,
  editable,
  itemsEndpoint,
  onItemsChange,
  emptyCatalogSlot,
}: OrderItemsEditorProps) {
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addonsTarget, setAddonsTarget] = useState<CatalogItem | null>(null);
  const [editingLine, setEditingLine] = useState<OrderItem | null>(null);

  const catalogById = new Map(catalogItems.map((c) => [c.id, c]));
  // Items with add-on groups stay pickable even once on the order — a
  // second, differently-configured line is a legitimate distinct add.
  const availableCatalogItems = catalogItems.filter(
    (c) => (c.addon_groups?.length ?? 0) > 0 || !items.some((oi) => oi.catalog_item_id === c.id),
  );

  const addItem = useCallback(
    async (catalogItemId: string, addOns?: AddonSelection[], applyToAll?: boolean) => {
      setBusy(true);
      try {
        const result = await queueableFetch<{ items: OrderItem[] }>(itemsEndpoint, "POST", {
          catalog_item_id: catalogItemId,
          add_ons: addOns,
          apply_to_all: applyToAll,
        }).catch((err: Error) => {
          toast.error(err.message || "Não foi possível adicionar o item.");
          return null;
        });
        if (!result) return;
        if (!result.ok) {
          toast.message("Sem conexão — o item será adicionado assim que a internet voltar.");
          return;
        }
        onItemsChange(result.data.items ?? []);
      } finally {
        setBusy(false);
      }
    },
    [itemsEndpoint, onItemsChange],
  );

  const setQuantity = useCallback(
    async (itemId: string, quantity: number) => {
      setBusy(true);
      try {
        const res = await fetch(`${itemsEndpoint}/${itemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantity }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? "Não foi possível atualizar o item.");
          return;
        }
        onItemsChange((data.items ?? []) as OrderItem[]);
      } finally {
        setBusy(false);
      }
    },
    [itemsEndpoint, onItemsChange],
  );

  const updateAddons = useCallback(
    async (itemId: string, quantity: number, addOns: AddonSelection[]) => {
      setBusy(true);
      try {
        const res = await fetch(`${itemsEndpoint}/${itemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantity, add_ons: addOns }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? "Não foi possível atualizar os adicionais.");
          return;
        }
        onItemsChange((data.items ?? []) as OrderItem[]);
      } finally {
        setBusy(false);
      }
    },
    [itemsEndpoint, onItemsChange],
  );

  const handlePick = (item: CatalogItem) => {
    if (item.addon_groups?.length) {
      setPickerOpen(false);
      setEditingLine(null);
      setAddonsTarget(item);
      return;
    }
    void addItem(item.id);
  };

  const handleAddonsConfirm = (selection: AddonSelection[], applyToAll: boolean) => {
    if (editingLine) {
      void updateAddons(editingLine.id, editingLine.quantity, selection);
    } else if (addonsTarget) {
      void addItem(addonsTarget.id, selection, applyToAll);
    }
    setAddonsTarget(null);
    setEditingLine(null);
  };

  return (
    <div>
      {items.length > 0 && (
        <ul className="mb-2 space-y-2">
          {items.map((line) => {
            const catalogItem = line.catalog_item_id ? catalogById.get(line.catalog_item_id) : undefined;
            const canEditAddons = editable && (catalogItem?.addon_groups?.length ?? 0) > 0;
            return (
              <li key={line.id} className="space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-foreground">{line.name_snapshot}</span>
                  {editable ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setQuantity(line.id, line.quantity - 1)}
                        className="flex h-5 w-5 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                      <span className="w-4 text-center text-foreground">{line.quantity}</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setQuantity(line.id, line.quantity + 1)}
                        className="flex h-5 w-5 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <span className="shrink-0 text-muted-foreground">×{line.quantity}</span>
                  )}
                  <span className="w-16 shrink-0 text-right text-muted-foreground">
                    {formatCurrency(line.total_cents / 100, currency)}
                  </span>
                  {editable && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setQuantity(line.id, 0)}
                      className="shrink-0 text-red-400 hover:text-red-300 disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {(line.addons?.length ?? 0) > 0 && (
                  <ul className="pl-3 text-[11px] text-muted-foreground">
                    {line.addons!.map((a) => (
                      <li key={a.id}>
                        + {a.name_snapshot}
                        {a.price_cents_snapshot > 0 && ` (${formatCurrency(a.price_cents_snapshot / 100, currency)})`}
                      </li>
                    ))}
                  </ul>
                )}
                {canEditAddons && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setAddonsTarget(catalogItem ?? null);
                      setEditingLine(line);
                    }}
                    className="ml-3 flex items-center gap-1 text-[11px] text-primary hover:underline disabled:opacity-50"
                  >
                    <Settings2 className="h-3 w-3" />
                    Editar adicionais
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editable &&
        (availableCatalogItems.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setPickerOpen(true)}
            className="h-8 w-full justify-start gap-1.5 bg-card text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            Adicionar item
          </Button>
        ) : (
          items.length === 0 && emptyCatalogSlot
        ))}

      <CatalogPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        items={availableCatalogItems}
        currency={currency}
        busy={busy}
        onPick={handlePick}
      />

      <AddonsPickerDialog
        open={!!addonsTarget}
        onOpenChange={(open) => {
          if (!open) {
            setAddonsTarget(null);
            setEditingLine(null);
          }
        }}
        item={addonsTarget}
        currency={currency}
        initialSelection={editingLine?.addons}
        showApplyToAll={!editingLine}
        busy={busy}
        onConfirm={handleAddonsConfirm}
      />
    </div>
  );
}
