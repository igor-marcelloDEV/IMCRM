"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import type { Contact, Order, OrderItem, OrderPayment, OrderPaymentMethod, CatalogItem } from "@/types";
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
  Loader2,
  Minus,
  Plus,
  Trash2,
  Receipt,
  Wallet,
  User,
  Phone,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { CatalogPickerDialog } from "@/components/pipelines/catalog-picker-dialog";
import { InvoiceCard } from "@/components/orders/invoice-card";
import { ReceiptDialog } from "@/components/orders/receipt-dialog";

interface OrderDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string | null;
  onSaved: () => void;
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</p>
      {children}
    </div>
  );
}

const PAYMENT_METHODS: OrderPaymentMethod[] = ["cash", "pix_manual", "card_debit", "card_credit", "other"];

export function OrderDetailSheet({ open, onOpenChange, orderId, onSaved }: OrderDetailSheetProps) {
  const t = useTranslations("Orders.detail");
  const supabase = createClient();

  const [loading, setLoading] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [payments, setPayments] = useState<OrderPayment[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);

  const [itemsBusy, setItemsBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const [paymentMethod, setPaymentMethod] = useState<OrderPaymentMethod>("cash");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [recordingPayment, setRecordingPayment] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    const [{ data: orderRow }, { data: itemRows }, { data: paymentRows }, { data: catalog }] =
      await Promise.all([
        supabase.from("orders").select("*, contact:contacts(*)").eq("id", orderId).maybeSingle(),
        supabase.from("order_items").select("*").eq("order_id", orderId).order("created_at"),
        supabase
          .from("order_payments")
          .select("*")
          .eq("order_id", orderId)
          .order("created_at"),
        supabase.from("catalog_items").select("*").eq("is_active", true).order("position"),
      ]);
    const o = (orderRow as (Order & { contact: Contact | null }) | null) ?? null;
    setOrder(o);
    setContact(o?.contact ?? null);
    setNotes(o?.notes ?? "");
    setItems((itemRows as OrderItem[] | null) ?? []);
    setPayments((paymentRows as OrderPayment[] | null) ?? []);
    setCatalogItems((catalog as CatalogItem[] | null) ?? []);
    setLoading(false);
  }, [orderId, supabase]);

  useEffect(() => {
    if (open && orderId) void load();
    if (!open) {
      setOrder(null);
      setItems([]);
      setPayments([]);
    }
  }, [open, orderId, load]);

  const applyItemsResponse = useCallback((nextItems: OrderItem[]) => {
    setItems(nextItems);
    const totalCents = nextItems.reduce((s, i) => s + i.total_cents, 0);
    setOrder((prev) => (prev ? { ...prev, subtotal_cents: totalCents, total_cents: totalCents } : prev));
  }, []);

  const addCatalogItem = useCallback(
    async (catalogItemId: string) => {
      if (!order) return;
      setItemsBusy(true);
      try {
        const res = await fetch(`/api/orders/${order.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ catalog_item_id: catalogItemId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t("toastFailed"));
          return;
        }
        applyItemsResponse((data.items ?? []) as OrderItem[]);
      } finally {
        setItemsBusy(false);
      }
    },
    [order, applyItemsResponse, t],
  );

  const setItemQuantity = useCallback(
    async (itemId: string, quantity: number) => {
      if (!order) return;
      setItemsBusy(true);
      try {
        const res = await fetch(`/api/orders/${order.id}/items/${itemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantity }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t("toastFailed"));
          return;
        }
        applyItemsResponse((data.items ?? []) as OrderItem[]);
      } finally {
        setItemsBusy(false);
      }
    },
    [order, applyItemsResponse, t],
  );

  const paidCents = payments.reduce((s, p) => s + p.amount_cents, 0);
  const balanceCents = Math.max(0, (order?.total_cents ?? 0) - paidCents);
  const isOpen = order?.status === "pending_payment";
  const availableCatalogItems = catalogItems.filter(
    (c) => !items.some((oi) => oi.catalog_item_id === c.id),
  );

  async function recordPayment() {
    if (!order) return;
    const amountCents = Math.round(parseFloat(paymentAmount.replace(",", ".")) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      toast.error(t("payments.toastInvalidAmount"));
      return;
    }
    setRecordingPayment(true);
    try {
      const res = await fetch(`/api/orders/${order.id}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: paymentMethod, amount_cents: amountCents }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("payments.toastFailed"));
        return;
      }
      setOrder(data.order as Order);
      setPayments((data.payments ?? []) as OrderPayment[]);
      setPaymentAmount("");
      toast.success(
        data.order.status === "paid" ? t("payments.toastFullyPaid") : t("payments.toastRecorded"),
      );
      onSaved();
    } finally {
      setRecordingPayment(false);
    }
  }

  async function cancelOrder() {
    if (!order) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "canceled" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("toastFailed"));
        return;
      }
      toast.success(t("toastCanceled"));
      onSaved();
      onOpenChange(false);
    } finally {
      setCancelling(false);
    }
  }

  async function saveNotes() {
    if (!order || notes === (order.notes ?? "")) return;
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes.trim() || null }),
      });
      if (res.ok) setOrder((prev) => (prev ? { ...prev, notes: notes.trim() || null } : prev));
    } finally {
      setSavingNotes(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full border-border bg-popover p-0 text-popover-foreground sm:max-w-lg">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {order
                ? `${order.source === "manual" ? t("titleComanda") : t("titleOrder")} #${order.order_number}`
                : t("titleOrder")}
            </SheetTitle>
          </SheetHeader>

          {loading || !order ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto p-4 space-y-5">
                <FormSection title={t("sectionCustomer")}>
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <User className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">
                        {contact?.name || contact?.phone || t("unknownContact")}
                      </p>
                      {contact?.phone && (
                        <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <Phone className="h-3 w-3" /> {contact.phone}
                        </p>
                      )}
                    </div>
                    <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {t(`status.${order.status}`)}
                    </span>
                  </div>
                </FormSection>

                <FormSection title={t("sectionItems")}>
                  <div className="rounded-lg border border-border bg-muted/40 p-3">
                    {items.length > 0 && (
                      <ul className="mb-2 space-y-1.5">
                        {items.map((line) => (
                          <li key={line.id} className="flex items-center gap-2 text-xs">
                            <span className="min-w-0 flex-1 truncate text-foreground">
                              {line.name_snapshot}
                            </span>
                            {isOpen ? (
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
                            ) : (
                              <span className="shrink-0 text-muted-foreground">×{line.quantity}</span>
                            )}
                            <span className="w-16 shrink-0 text-right text-muted-foreground">
                              {formatCurrency(line.total_cents / 100, order.currency)}
                            </span>
                            {isOpen && (
                              <button
                                type="button"
                                disabled={itemsBusy}
                                onClick={() => setItemQuantity(line.id, 0)}
                                className="shrink-0 text-red-400 hover:text-red-300 disabled:opacity-50"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {isOpen &&
                      (availableCatalogItems.length > 0 ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={itemsBusy}
                          onClick={() => setPickerOpen(true)}
                          className="h-8 w-full justify-start gap-1.5 bg-card text-xs"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {t("items.addPlaceholder")}
                        </Button>
                      ) : items.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("items.emptyCatalog")}</p>
                      ) : null)}
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <span className="text-sm font-medium text-foreground">{t("total")}</span>
                    <span className="text-sm font-semibold text-primary">
                      {formatCurrency(order.total_cents / 100, order.currency)}
                    </span>
                  </div>
                </FormSection>

                <FormSection title={t("sectionPayments")}>
                  {payments.length > 0 && (
                    <ul className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-3">
                      {payments.map((p) => (
                        <li key={p.id} className="flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1.5 text-foreground">
                            <Wallet className="h-3 w-3 text-muted-foreground" />
                            {t(`payments.method.${p.method}`)}
                          </span>
                          <span className="text-muted-foreground">
                            {formatCurrency(p.amount_cents / 100, order.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {order.status === "paid" ? (
                    <p className="text-xs text-primary">{t("payments.fullyPaid")}</p>
                  ) : order.status === "canceled" ? (
                    <p className="text-xs text-muted-foreground">{t("payments.canceledNote")}</p>
                  ) : (
                    <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{t("payments.balance")}</span>
                        <span className="font-semibold text-foreground">
                          {formatCurrency(balanceCents / 100, order.currency)}
                        </span>
                      </div>
                      <div className="grid grid-cols-[1fr_100px] gap-2">
                        <Select
                          value={paymentMethod}
                          onValueChange={(v) => v && setPaymentMethod(v as OrderPaymentMethod)}
                        >
                          <SelectTrigger className="h-8 bg-card text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PAYMENT_METHODS.map((m) => (
                              <SelectItem key={m} value={m}>
                                {t(`payments.method.${m}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          type="number"
                          step="0.01"
                          value={paymentAmount}
                          onChange={(e) => setPaymentAmount(e.target.value)}
                          placeholder={(balanceCents / 100).toFixed(2)}
                          className="h-8 bg-card text-xs"
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 w-full text-xs"
                        disabled={recordingPayment}
                        onClick={recordPayment}
                      >
                        {recordingPayment && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                        {t("payments.record")}
                      </Button>
                    </div>
                  )}
                </FormSection>

                {order.invoice_id && (
                  <InvoiceCard orderId={order.id} invoiceStatus={order.invoice_status} />
                )}

                <FormSection title={t("sectionNotes")}>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    onBlur={saveNotes}
                    placeholder={t("notesPlaceholder")}
                    className="min-h-[60px] border-border bg-muted text-foreground"
                    disabled={savingNotes}
                  />
                </FormSection>
              </div>

              <div className="border-t border-border/50 bg-popover/80 p-4">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setReceiptOpen(true)}
                    className="flex-1 gap-1.5 border-border bg-transparent text-muted-foreground hover:bg-muted"
                  >
                    <Receipt className="h-4 w-4" />
                    {t("receipt")}
                  </Button>
                  {isOpen && (
                    <Button
                      variant="ghost"
                      onClick={cancelOrder}
                      disabled={cancelling}
                      className="text-red-400 hover:text-red-300"
                    >
                      {cancelling && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                      {t("cancelOrder")}
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </SheetContent>

      <CatalogPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        items={availableCatalogItems}
        currency={order?.currency ?? "BRL"}
        busy={itemsBusy}
        onAdd={(id) => {
          void addCatalogItem(id);
        }}
      />

      {order && (
        <ReceiptDialog
          open={receiptOpen}
          onOpenChange={setReceiptOpen}
          order={order}
          items={items}
          contact={contact}
        />
      )}
    </Sheet>
  );
}
