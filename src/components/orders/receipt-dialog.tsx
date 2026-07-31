"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/currency";
import type { Contact, Order, OrderItem } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy, MessageCircle, Printer } from "lucide-react";
import { useTranslations } from "next-intl";

interface ReceiptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: Order;
  items: OrderItem[];
  contact: Contact | null;
}

interface Branding {
  name: string;
  logo_url: string | null;
}

/**
 * The document IMCRM itself generates for a sale — NOT the official
 * NFS-e (that PDF's layout is the municipality's, via Asaas; see
 * InvoiceCard). This is whatever the tenant wants to hand/send a
 * customer as proof of purchase, so it carries THEIR branding
 * (name + logo, migration 064's whitelabel fields), not IMCRM's.
 */
export function ReceiptDialog({ open, onOpenChange, order, items, contact }: ReceiptDialogProps) {
  const t = useTranslations("Orders.receipt");
  const [branding, setBranding] = useState<Branding | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/account");
      const data = await res.json().catch(() => ({}));
      if (!cancelled && res.ok && data.account) {
        setBranding({ name: data.account.name, logo_url: data.account.logo_url ?? null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const date = new Date(order.created_at).toLocaleString();

  function receiptText(): string {
    const lines = [
      branding?.name ?? "",
      "—".repeat(20),
      ...items.map(
        (i) =>
          `${i.quantity}x ${i.name_snapshot} — ${formatCurrency(i.total_cents / 100, order.currency)}`,
      ),
      "—".repeat(20),
      `${t("total")}: ${formatCurrency(order.total_cents / 100, order.currency)}`,
      `${t("date")}: ${date}`,
    ];
    return lines.filter(Boolean).join("\n");
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(receiptText());
      toast.success(t("toastCopied"));
    } catch {
      toast.error(t("toastCopyFailed"));
    }
  }

  function shareOnWhatsApp() {
    const phone = contact?.phone ? contact.phone.replace(/\D/g, "") : "";
    const text = encodeURIComponent(receiptText());
    const url = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-sm p-0">
        <DialogHeader className="border-b border-border px-5 pt-5 pb-4">
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        <div className="print-only-area px-5 py-4">
          <div className="flex flex-col items-center gap-2 text-center">
            {branding?.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logo_url} alt={branding.name} className="h-14 w-14 rounded object-contain" />
            )}
            <p className="text-base font-semibold text-foreground">{branding?.name ?? "…"}</p>
            <p className="text-xs text-muted-foreground">{date}</p>
          </div>

          <div className="mt-4 space-y-1.5 border-t border-dashed border-border pt-3">
            {items.map((i) => (
              <div key={i.id} className="flex items-center justify-between text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {i.quantity}× {i.name_snapshot}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {formatCurrency(i.total_cents / 100, order.currency)}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-dashed border-border pt-3">
            <span className="text-sm font-semibold text-foreground">{t("total")}</span>
            <span className="text-sm font-semibold text-primary">
              {formatCurrency(order.total_cents / 100, order.currency)}
            </span>
          </div>
        </div>

        <div className="flex gap-2 border-t border-border p-4">
          <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={copyText}>
            <Copy className="h-3.5 w-3.5" />
            {t("copy")}
          </Button>
          <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" />
            {t("print")}
          </Button>
          <Button size="sm" className="flex-1 gap-1.5" onClick={shareOnWhatsApp}>
            <MessageCircle className="h-3.5 w-3.5" />
            {t("shareWhatsapp")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
