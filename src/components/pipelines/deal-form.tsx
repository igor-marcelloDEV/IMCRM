"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CURRENCIES, formatCurrency } from "@/lib/currency";
import type {
  CatalogItem,
  Contact,
  Conversation,
  Deal,
  DealStatus,
  OrderItem,
  PipelineStage,
  Profile,
} from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Check,
  X,
  Trash2,
  MessageSquare,
  DollarSign,
  Loader2,
  Package,
  Minus,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface DealFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal?: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  onSaved: () => void;
}

// Section wrapper — every group of fields gets a small uppercase label
// and consistent spacing so the sheet reads as scannable chunks
// instead of one long undifferentiated list of inputs.
function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</p>
      {children}
    </div>
  );
}

export function DealForm({
  open,
  onOpenChange,
  deal,
  pipelineId,
  stages,
  defaultStageId,
  onSaved,
}: DealFormProps) {
  const t = useTranslations("Pipelines.form");
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [contactId, setContactId] = useState("");
  const [stageId, setStageId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [notes, setNotes] = useState("");

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [linkedConversation, setLinkedConversation] =
    useState<Conversation | null>(null);

  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [itemsBusy, setItemsBusy] = useState(false);

  const [saving, setSaving] = useState(false);
  const [statusAction, setStatusAction] = useState<DealStatus | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset the form fields every time the sheet opens or its input
  // props change. This is a legitimate prop-driven sync; the rule is
  // over-cautious here, hence the block-level disable.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    if (deal) {
      setTitle(deal.title);
      setValue(String(deal.value ?? ""));
      setCurrency(deal.currency || defaultCurrency);
      // contact_id is nullable when the contact has been deleted
      // (migration 004: ON DELETE SET NULL). "" means "no selection".
      setContactId(deal.contact_id ?? "");
      setStageId(deal.stage_id);
      setAssignedTo(deal.assigned_to ?? "");
      setExpectedCloseDate(deal.expected_close_date ?? "");
      setNotes(deal.notes ?? "");
    } else {
      setTitle("");
      setValue("");
      setCurrency(defaultCurrency);
      setContactId("");
      setStageId(defaultStageId || stages[0]?.id || "");
      setAssignedTo("");
      setExpectedCloseDate("");
      setNotes("");
    }
  }, [open, deal, defaultStageId, stages, defaultCurrency]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Load supporting data once the sheet is open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [c, p, ci] = await Promise.all([
        supabase.from("contacts").select("*").order("name"),
        supabase.from("profiles").select("*").order("full_name"),
        supabase.from("catalog_items").select("*").eq("is_active", true).order("position"),
      ]);
      if (cancelled) return;
      setContacts((c.data ?? []) as Contact[]);
      setProfiles((p.data ?? []) as Profile[]);
      setCatalogItems((ci.data ?? []) as CatalogItem[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  // Catalog items attached to this deal, via the Order the API routes
  // below create/maintain on first add (orders.deal_id). Only existing
  // deals have somewhere to attach items to — a not-yet-saved deal
  // shows no items section at all (see the JSX below).
  useEffect(() => {
    if (!open || !deal) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOrderItems([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: order } = await supabase
        .from("orders")
        .select("id")
        .eq("deal_id", deal.id)
        .maybeSingle();
      if (!order) {
        if (!cancelled) setOrderItems([]);
        return;
      }
      const { data: items } = await supabase
        .from("order_items")
        .select("*")
        .eq("order_id", order.id)
        .order("created_at", { ascending: true });
      if (!cancelled) setOrderItems((items as OrderItem[] | null) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, deal, supabase]);

  // Fetch linked conversation for the selected contact (newest open one).
  // Clearing on no-selection is sync with prop state; the populated
  // case runs setLinkedConversation inside the async fetch callback.
  useEffect(() => {
    if (!open || !contactId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLinkedConversation(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .eq("contact_id", contactId)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setLinkedConversation((data as Conversation | null) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, supabase]);

  const applyItemsResponse = useCallback((items: OrderItem[]) => {
    setOrderItems(items);
    const totalCents = items.reduce((s, i) => s + i.total_cents, 0);
    // The Value field mirrors the items total but stays a plain
    // editable input — an agent can still hand-adjust it afterward
    // (a discount, a rounded quote) without the items list fighting
    // back on every keystroke.
    setValue(String(totalCents / 100));
  }, []);

  const addCatalogItem = useCallback(
    async (catalogItemId: string) => {
      if (!deal) return;
      setItemsBusy(true);
      try {
        const res = await fetch(`/api/deals/${deal.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ catalog_item_id: catalogItemId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t("items.toastFailed"));
          return;
        }
        applyItemsResponse((data.items ?? []) as OrderItem[]);
      } finally {
        setItemsBusy(false);
      }
    },
    [deal, applyItemsResponse, t],
  );

  const setItemQuantity = useCallback(
    async (itemId: string, quantity: number) => {
      if (!deal) return;
      setItemsBusy(true);
      try {
        const res = await fetch(`/api/deals/${deal.id}/items/${itemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantity }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t("items.toastFailed"));
          return;
        }
        applyItemsResponse((data.items ?? []) as OrderItem[]);
      } finally {
        setItemsBusy(false);
      }
    },
    [deal, applyItemsResponse, t],
  );

  async function handleSave() {
    if (!title.trim() || !contactId || !stageId) {
      toast.error(t("toastRequired"));
      return;
    }
    setSaving(true);

    const payload = {
      title: title.trim(),
      value: parseFloat(value) || 0,
      currency,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: assignedTo || null,
      notes: notes.trim() || null,
      expected_close_date: expectedCloseDate || null,
    };

    if (deal) {
      const { error } = await supabase
        .from("deals")
        .update(payload)
        .eq("id", deal.id);
      if (error) {
        toast.error(t("toastFailedSave"));
        setSaving(false);
        return;
      }
    } else {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        toast.error(t("toastNotSignedIn"));
        setSaving(false);
        return;
      }
      if (!accountId) {
        toast.error(t("toastNotLinked"));
        setSaving(false);
        return;
      }
      const { error } = await supabase
        .from("deals")
        .insert({ ...payload, user_id: user.id, account_id: accountId, status: "open" });
      if (error) {
        toast.error(t("toastFailedCreate"));
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    toast.success(deal ? t("toastUpdated") : t("toastCreated"));
    onOpenChange(false);
    onSaved();
  }

  async function handleStatusChange(status: DealStatus) {
    if (!deal) return;
    setStatusAction(status);
    const { error } = await supabase
      .from("deals")
      .update({ status })
      .eq("id", deal.id);
    setStatusAction(null);
    if (error) {
      toast.error(t("toastFailedStatus"));
      return;
    }
    toast.success(
      status === "won" ? t("toastMarkedWon") : status === "lost" ? t("toastMarkedLost") : t("toastReopened"),
    );
    onOpenChange(false);
    onSaved();
  }

  async function handleDelete() {
    if (!deal) return;
    setDeleting(true);
    const { error } = await supabase.from("deals").delete().eq("id", deal.id);
    setDeleting(false);
    if (error) {
      toast.error(t("toastFailedDelete"));
      return;
    }
    toast.success(t("toastDeleted"));
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
  }

  const itemsTotalCents = orderItems.reduce((s, i) => s + i.total_cents, 0);
  const availableCatalogItems = catalogItems.filter(
    (c) => !orderItems.some((oi) => oi.catalog_item_id === c.id),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {deal ? t("editDeal") : t("newDeal")}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            <FormSection title={t("sectionEssentials")}>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("title")}</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("titlePlaceholder")}
                  className="border-border bg-muted text-foreground"
                />
              </div>

              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("contact")}</Label>
                <Select value={contactId || "__none__"} onValueChange={(v) => setContactId(v === "__none__" ? "" : (v ?? ""))}>
                  <SelectTrigger className="bg-muted">
                    <SelectValue placeholder={t("selectContact")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t("selectContact")}</SelectItem>
                    {contacts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name || c.phone}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {linkedConversation && (
                  <Link
                    href="/inbox"
                    className="mt-1 inline-flex items-center gap-1.5 self-start rounded-md bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                  >
                    <MessageSquare className="h-3 w-3" />
                    {t("linkToConversation")}
                  </Link>
                )}
              </div>
            </FormSection>

            <FormSection title={t("sectionValue")}>
              {deal && (
                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Package className="h-3.5 w-3.5" />
                      {t("items.title")}
                    </span>
                    {itemsTotalCents > 0 && (
                      <span className="text-xs font-semibold text-primary">
                        {formatCurrency(itemsTotalCents / 100, currency)}
                      </span>
                    )}
                  </div>

                  {orderItems.length > 0 && (
                    <ul className="mb-2 space-y-1.5">
                      {orderItems.map((line) => (
                        <li key={line.id} className="flex items-center gap-2 text-xs">
                          <span className="min-w-0 flex-1 truncate text-foreground">{line.name_snapshot}</span>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              disabled={itemsBusy}
                              onClick={() => setItemQuantity(line.id, line.quantity - 1)}
                              className="flex h-5 w-5 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
                            >
                              <Minus className="h-3 w-3" />
                            </button>
                            <span className="w-4 text-center text-foreground">{line.quantity}</span>
                            <button
                              type="button"
                              disabled={itemsBusy}
                              onClick={() => setItemQuantity(line.id, line.quantity + 1)}
                              className="flex h-5 w-5 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                          </div>
                          <span className="w-16 shrink-0 text-right text-muted-foreground">
                            {formatCurrency(line.total_cents / 100, currency)}
                          </span>
                          <button
                            type="button"
                            disabled={itemsBusy}
                            onClick={() => setItemQuantity(line.id, 0)}
                            className="shrink-0 text-red-400 hover:text-red-300 disabled:opacity-50"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {availableCatalogItems.length > 0 ? (
                    <Select
                      value=""
                      onValueChange={(v) => v && addCatalogItem(v)}
                      disabled={itemsBusy}
                    >
                      <SelectTrigger className="h-8 bg-card text-xs">
                        <SelectValue placeholder={t("items.addPlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        {availableCatalogItems.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name} — {formatCurrency(c.price_cents / 100, c.currency)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : catalogItems.length === 0 ? (
                    <Link href="/settings?tab=catalog" className="text-xs text-primary hover:underline">
                      {t("items.emptyCatalogCta")}
                    </Link>
                  ) : null}
                </div>
              )}

              <div className="grid grid-cols-[1fr_110px] gap-3">
                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t("value")}</Label>
                  <div className="relative">
                    <DollarSign className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      type="number"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder="0"
                      className="border-border bg-muted pl-7 text-foreground"
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t("currency")}</Label>
                  <Select value={currency} onValueChange={(v) => v && setCurrency(v)}>
                    <SelectTrigger className="bg-muted">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.code}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </FormSection>

            <FormSection title={t("sectionProgress")}>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t("stage")}</Label>
                  <Select value={stageId} onValueChange={(v) => v && setStageId(v)}>
                    <SelectTrigger className="bg-muted">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {stages.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t("assignedTo")}</Label>
                  <Select value={assignedTo || "__none__"} onValueChange={(v) => setAssignedTo(v === "__none__" ? "" : (v ?? ""))}>
                    <SelectTrigger className="bg-muted">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t("unassigned")}</SelectItem>
                      {profiles.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.full_name || p.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("expectedCloseDate")}</Label>
                <Input
                  type="date"
                  value={expectedCloseDate}
                  onChange={(e) => setExpectedCloseDate(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </FormSection>

            <FormSection title={t("notes")}>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("notesPlaceholder")}
                className="min-h-[80px] border-border bg-muted text-foreground"
              />
            </FormSection>

            {deal && (
              <FormSection title={t("status")}>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    onClick={() => handleStatusChange("won")}
                    disabled={!!statusAction || deal.status === "won"}
                    className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {statusAction === "won" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Check className="mr-1 h-4 w-4 shrink-0" />
                        <span className="truncate">{t("markAsWon")}</span>
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => handleStatusChange("lost")}
                    disabled={!!statusAction || deal.status === "lost"}
                    className="bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {statusAction === "lost" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <X className="mr-1 h-4 w-4 shrink-0" />
                        <span className="truncate">{t("markAsLost")}</span>
                      </>
                    )}
                  </Button>
                </div>
                {deal.status && deal.status !== "open" && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleStatusChange("open")}
                    disabled={!!statusAction}
                    className="w-full text-muted-foreground hover:text-foreground"
                  >
                    {t("reopenDeal")}
                  </Button>
                )}
              </FormSection>
            )}
          </div>

          <div className="border-t border-border/50 bg-popover/80 p-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !title.trim() || !contactId || !stageId}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? t("saving") : deal ? t("saveChanges") : t("createDeal")}
              </Button>
            </div>

            {deal &&
              (confirmDelete ? (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
                  <span className="text-red-300">{t("deletePrompt")}</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? t("deleting") : t("confirm")}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="mt-3 flex w-full items-center justify-center gap-1 text-xs text-red-400 hover:text-red-300"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("deleteDeal")}
                </button>
              ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
