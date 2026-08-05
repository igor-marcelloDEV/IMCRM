"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
  Receipt,
  Wallet,
  User,
  Phone,
  Pencil,
  Check,
  GitBranch,
  MessageCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { OrderItemsEditor } from "@/components/orders/order-items-editor";
import { SYNCED_EVENT } from "@/lib/offline/outbox";
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
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [pipelineInfo, setPipelineInfo] = useState<{ pipeline: string; stage: string } | null>(null);
  const [editingContactName, setEditingContactName] = useState(false);
  const [contactName, setContactName] = useState('');
  const [savingContactName, setSavingContactName] = useState(false);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [payments, setPayments] = useState<OrderPayment[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);

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
        supabase.from("orders").select("*, contact:contacts(*), deal:deals(pipeline:pipelines(name), stage:pipeline_stages(name))").eq("id", orderId).maybeSingle(),
        supabase.from("order_items").select("*, addons:order_item_addons(*)").eq("order_id", orderId).order("created_at"),
        supabase
          .from("order_payments")
          .select("*")
          .eq("order_id", orderId)
          .order("created_at"),
        supabase
          .from("catalog_items")
          .select("*, addon_groups:catalog_item_addon_groups(id,account_id,catalog_item_id,name,required,min_select,max_select,position,options:catalog_item_addons(id,group_id,name,price_cents,is_active,position))")
          .eq("is_active", true)
          .order("position"),
      ]);
    const o = (orderRow as (Order & { contact: Contact | null; deal: { pipeline: { name: string } | null; stage: { name: string } | null } | null }) | null) ?? null;
    setOrder(o);
    setContact(o?.contact ?? null);
    setContactName(o?.contact?.name ?? '');
    setPipelineInfo(o?.deal ? { pipeline: o.deal.pipeline?.name ?? '—', stage: o.deal.stage?.name ?? '—' } : null);
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

  // A queued offline item-add just landed on the server — refetch so
  // it actually shows up (see src/lib/offline/outbox.ts).
  useEffect(() => {
    if (!open || !orderId) return;
    const onSynced = () => void load();
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(SYNCED_EVENT, onSynced);
  }, [open, orderId, load]);

  const applyItemsResponse = useCallback((nextItems: OrderItem[]) => {
    setItems(nextItems);
    const totalCents = nextItems.reduce((s, i) => s + i.total_cents, 0);
    setOrder((prev) => (prev ? { ...prev, subtotal_cents: totalCents, total_cents: totalCents } : prev));
  }, []);

  const paidCents = payments.reduce((s, p) => s + p.amount_cents, 0);
  const balanceCents = Math.max(0, (order?.total_cents ?? 0) - paidCents);
  const isOpen = order?.status === "pending_payment";

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

  async function saveContactName() {
    const nextName = contactName.trim();
    if (!contact || nextName.length < 2) return;
    setSavingContactName(true);
    const { error } = await supabase.from('contacts').update({ name: nextName, updated_at: new Date().toISOString() }).eq('id', contact.id);
    if (error) toast.error(t('contactEditFailed'));
    else {
      setContact({ ...contact, name: nextName });
      setEditingContactName(false);
      toast.success(t('contactEdited'));
      onSaved();
    }
    setSavingContactName(false);
  }

  async function openInternalConversation(message: string) {
    if (!contact) return;
    const { data: conversation, error } = await supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', contact.id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (error || !conversation) {
      toast.error(t('conversationNotFound'));
      return;
    }

    onOpenChange(false);
    router.push(`/inbox?c=${conversation.id}&draft=${encodeURIComponent(message)}`);
  }

  async function openRecoveryMessage() {
    if (!order || !contact) return;
    const customerName = contact.name && !/^\+?\d[\d\s().-]+$/.test(contact.name) ? contact.name.split(' ')[0] : '';
    const paymentUrl = `${window.location.origin}/loja/${order.account_id}/pedido/${order.id}`;
    const message = t('recoveryMessage', { name: customerName, order: order.order_code, link: paymentUrl });
    await openInternalConversation(message);
  }

  async function openOrderWhatsApp() {
    if (!order || !contact) return;
    const customerName = contact.name && !/^\+?\d[\d\s().-]+$/.test(contact.name)
      ? contact.name.split(' ')[0]
      : '';
    const message = t('orderWhatsappMessage', {
      name: customerName,
      order: order.order_code,
    });
    await openInternalConversation(message);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full border-border bg-popover p-0 text-popover-foreground sm:max-w-lg">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {order
                ? `${order.source === "manual" ? t("titleComanda") : t("titleOrder")} #${order.order_code}`
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
                    <div className="min-w-0 flex-1">
                      {editingContactName ? (
                        <Input value={contactName} onChange={(event) => setContactName(event.target.value)} className="h-8 bg-card" autoFocus onKeyDown={(event) => { if (event.key === 'Enter') void saveContactName(); }} />
                      ) : <p className="truncate font-medium text-foreground">{contact?.name || contact?.phone || t("unknownContact")}</p>}
                      {contact?.phone && (
                        <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <Phone className="h-3 w-3" /> {contact.phone}
                        </p>
                      )}
                    </div>
                    {contact && (editingContactName ? (
                      <Button size="icon-sm" variant="ghost" disabled={savingContactName || contactName.trim().length < 2} onClick={() => void saveContactName()} aria-label={t('saveContactName')}><Check className="h-4 w-4" /></Button>
                    ) : (
                      <Button size="icon-sm" variant="ghost" onClick={() => setEditingContactName(true)} aria-label={t('editContact')}><Pencil className="h-4 w-4" /></Button>
                    ))}
                    <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {t(`status.${order.status}`)}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full border-emerald-500/30 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 hover:text-emerald-400"
                    onClick={() => void openOrderWhatsApp()}
                    disabled={!contact}
                  >
                    <MessageCircle className="mr-2 h-4 w-4" />
                    {t('contactOnWhatsapp')}
                  </Button>
                </FormSection>

                <FormSection title={t('sectionFunnel')}>
                  <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
                    <GitBranch className="h-4 w-4 text-primary" />
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-foreground">{pipelineInfo?.pipeline ?? t('noFunnel')}</p><p className="text-xs text-muted-foreground">{pipelineInfo?.stage ?? t('noFunnelStage')}</p></div>
                  </div>
                </FormSection>

                {order.status === 'pending_payment' && (
                  <FormSection title={t('sectionRecovery')}>
                    <div className="space-y-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
                      <p className="text-xs leading-5 text-muted-foreground">{t('recoveryHint', { order: order.order_code })}</p>
                      <Button type="button" className="w-full" onClick={() => void openRecoveryMessage()} disabled={!contact}><MessageCircle className="mr-2 h-4 w-4" />{t('sendRecovery')}</Button>
                    </div>
                  </FormSection>
                )}

                <FormSection title={t("sectionItems")}>
                  <div className="rounded-lg border border-border bg-muted/40 p-3">
                    <OrderItemsEditor
                      items={items}
                      catalogItems={catalogItems}
                      currency={order.currency}
                      editable={isOpen}
                      itemsEndpoint={`/api/orders/${order.id}/items`}
                      onItemsChange={applyItemsResponse}
                      emptyCatalogSlot={<p className="text-xs text-muted-foreground">{t("items.emptyCatalog")}</p>}
                    />
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
