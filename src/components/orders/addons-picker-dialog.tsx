"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import type { CatalogItemAddonGroup, OrderItemAddon } from "@/types";

/** Minimal shape this dialog needs — deliberately looser than the full
 *  `CatalogItem` so the public storefront's smaller, public-safe item
 *  type can be passed in too without a cast. */
export interface AddonPickerItem {
  id: string;
  name: string;
  addon_groups?: CatalogItemAddonGroup[];
}
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface AddonSelection {
  addon_id: string;
  quantity: number;
}

interface AddonsPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: AddonPickerItem | null;
  currency: string;
  /** Pre-fills the picker when re-opening it to edit an existing line's add-ons. */
  initialSelection?: OrderItemAddon[];
  /** Hidden for the storefront (nothing to "apply to" until checkout). */
  showApplyToAll?: boolean;
  busy?: boolean;
  onConfirm: (selection: AddonSelection[], applyToAll: boolean) => void;
}

function groupIsSatisfied(group: CatalogItemAddonGroup, selectedIds: string[]): boolean {
  if (selectedIds.length === 0) return !group.required;
  return selectedIds.length >= group.min_select && selectedIds.length <= group.max_select;
}

export function AddonsPickerDialog({
  open,
  onOpenChange,
  item,
  currency,
  initialSelection,
  showApplyToAll = true,
  busy = false,
  onConfirm,
}: AddonsPickerDialogProps) {
  const groups = item?.addon_groups ?? [];
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [applyToAll, setApplyToAll] = useState(false);

  useEffect(() => {
    if (!open) return;
    setApplyToAll(false);
    if (!initialSelection?.length || !groups.length) {
      setSelected({});
      return;
    }
    const byGroup: Record<string, string[]> = {};
    for (const group of groups) {
      const ids = initialSelection
        .filter((a) => a.catalog_item_addon_id && group.options.some((o) => o.id === a.catalog_item_addon_id))
        .map((a) => a.catalog_item_addon_id as string);
      if (ids.length) byGroup[group.id] = ids;
    }
    setSelected(byGroup);
    // groups/initialSelection are derived from `item`, which only changes when the dialog re-opens for a different line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  if (!item) return null;

  const toggleOption = (group: CatalogItemAddonGroup, optionId: string) => {
    setSelected((prev) => {
      const current = prev[group.id] ?? [];
      const isSelected = current.includes(optionId);
      if (isSelected) {
        return { ...prev, [group.id]: current.filter((id) => id !== optionId) };
      }
      if (group.max_select <= 1) {
        return { ...prev, [group.id]: [optionId] };
      }
      if (current.length >= group.max_select) return prev;
      return { ...prev, [group.id]: [...current, optionId] };
    });
  };

  const allSatisfied = groups.every((g) => groupIsSatisfied(g, selected[g.id] ?? []));

  const handleConfirm = () => {
    if (!allSatisfied) return;
    const selection: AddonSelection[] = Object.values(selected)
      .flat()
      .map((addonId) => ({ addon_id: addonId, quantity: 1 }));
    onConfirm(selection, applyToAll);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {groups.map((group) => {
            const selectedIds = selected[group.id] ?? [];
            const satisfied = groupIsSatisfied(group, selectedIds);
            return (
              <div key={group.id}>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium text-foreground">{group.name}</p>
                  <span className={`text-[11px] ${satisfied ? "text-muted-foreground" : "text-amber-500"}`}>
                    {group.required
                      ? group.max_select > 1
                        ? `Escolha ${group.min_select}–${group.max_select}`
                        : "Obrigatório"
                      : `Até ${group.max_select}`}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {group.options.filter((o) => o.is_active).map((option) => {
                    const isSelected = selectedIds.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => toggleOption(group, option.id)}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                          isSelected ? "border-primary bg-primary/5 text-foreground" : "border-border text-foreground hover:bg-muted/50"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${isSelected ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
                            {isSelected && <Check className="h-3 w-3" />}
                          </span>
                          {option.name}
                        </span>
                        {option.price_cents > 0 && (
                          <span className="shrink-0 text-xs text-muted-foreground">+{formatCurrency(option.price_cents / 100, currency)}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {showApplyToAll && (
            <label className="flex items-center gap-2 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
              <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} className="h-4 w-4 rounded border-border" />
              Aplicar estes adicionais a todos os itens do pedido
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={handleConfirm} disabled={!allSatisfied || busy}>
            Adicionar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
