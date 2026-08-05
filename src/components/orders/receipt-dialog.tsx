"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/currency";
import type { Contact, Order, OrderItem } from "@/types";
import type { TaskActivity } from "@/lib/tasks/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy, History, Loader2, MessageCircle, Printer } from "lucide-react";
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
  legal_name: string | null;
  cnpj: string | null;
}

function formatCnpj(value: string | null | undefined): string {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits.length === 14 ? digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : '';
}

/** Fetches a remote image and returns it as a data URL, or null if it
 *  can't be loaded (missing file, CORS) — the PDF still renders fine
 *  without a logo, so callers should treat this as best-effort. */
async function urlToDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * The document IMCRM itself generates for a sale — NOT the official
 * NFS-e (that PDF's layout is the municipality's, via Asaas; see
 * InvoiceCard). This is whatever the tenant wants to hand/send a
 * customer as proof of purchase, so it carries THEIR branding
 * (name + logo, migration 064's whitelabel fields), not IMCRM's.
 *
 * Also doubles as the comanda's audit trail: every order.* activity
 * (opened, item added, payment recorded, canceled) is fetched and
 * shown underneath the itemized total, so "who added what and when"
 * survives even after the comanda closes.
 */
export function ReceiptDialog({ open, onOpenChange, order, items, contact }: ReceiptDialogProps) {
  const t = useTranslations("Orders.receipt");
  const [branding, setBranding] = useState<Branding | null>(null);
  const [history, setHistory] = useState<TaskActivity[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/account");
      const data = await res.json().catch(() => ({}));
      if (!cancelled && res.ok && data.account) {
        setBranding({ name: data.account.name, logo_url: data.account.logo_url ?? null, legal_name: data.account.legal_name ?? null, cnpj: data.account.cnpj ?? null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHistoryLoading(true);
    (async () => {
      const res = await fetch(`/api/activities?order_id=${order.id}&limit=50`);
      const data = await res.json().catch(() => ({}));
      if (!cancelled) {
        setHistory(res.ok ? ((data.activities ?? []) as TaskActivity[]) : []);
        setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, order.id]);

  const date = new Date(order.created_at).toLocaleString();
  const sortedHistory = [...history].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  function receiptText(): string {
    const lines = [
      branding?.name ?? "",
      branding?.legal_name && branding.legal_name !== branding.name ? branding.legal_name : "",
      branding?.cnpj ? `CNPJ: ${formatCnpj(branding.cnpj)}` : "",
      `${t("orderRef")} #${order.order_code}`,
      contact?.name ? `${t("customer")}: ${contact.name}` : "",
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

  async function buildPdfBlob(): Promise<Blob> {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const marginX = 18;
    let y = 20;

    if (branding?.logo_url) {
      const dataUrl = await urlToDataUrl(branding.logo_url);
      if (dataUrl) {
        try {
          doc.addImage(dataUrl, dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG', marginX, y, 18, 18);
        } catch {
          // Unsupported format (e.g. SVG) — skip the logo, not fatal.
        }
      }
    }

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(branding?.name ?? "", marginX + 22, y + 7);
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    const companyDetails = [branding?.legal_name && branding.legal_name !== branding.name ? branding.legal_name : '', branding?.cnpj ? `CNPJ: ${formatCnpj(branding.cnpj)}` : ''].filter(Boolean) as string[];
    companyDetails.forEach((detail, index) => doc.text(detail, marginX + 22, y + 13 + index * 4));
    y += Math.max(24, 18 + companyDetails.length * 4);

    doc.setFillColor(245, 247, 250);
    doc.roundedRect(marginX, y, 210 - marginX * 2, 20, 2, 2, 'F');
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(`${t("orderRef")} #${order.order_code}`, marginX + 4, y + 7);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`${t('date')}: ${date}`, marginX + 4, y + 13);
    if (contact?.name) doc.text(`${t('customer')}: ${contact.name}`, 210 - marginX - 4, y + 7, { align: 'right' });
    y += 27;

    doc.setDrawColor(200);
    doc.line(marginX, y, 210 - marginX, y);
    y += 7;

    doc.setFontSize(11);
    for (const item of items) {
      const label = `${item.quantity}x ${item.name_snapshot}`;
      const value = formatCurrency(item.total_cents / 100, order.currency);
      doc.text(label, marginX, y);
      doc.text(value, 210 - marginX, y, { align: "right" });
      y += 6;
    }

    doc.line(marginX, y, 210 - marginX, y);
    y += 7;
    doc.setFont("helvetica", "bold");
    doc.text(t("total"), marginX, y);
    doc.text(formatCurrency(order.total_cents / 100, order.currency), 210 - marginX, y, { align: "right" });
    y += 12;

    if (sortedHistory.length > 0) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text(t("historyTitle"), marginX, y);
      y += 6;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(90);
      for (const event of sortedHistory) {
        const when = new Date(event.created_at).toLocaleString();
        const rows = doc.splitTextToSize(`${when} — ${event.summary}`, 210 - marginX * 2);
        for (const row of rows) {
          if (y > 280) {
            doc.addPage();
            y = 20;
          }
          doc.text(row, marginX, y);
          y += 5;
        }
      }
      doc.setTextColor(0);
    }

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(t('nonFiscalDocument'), 105, 287, { align: 'center' });

    return doc.output("blob");
  }

  async function shareOnWhatsApp() {
    setSharing(true);
    try {
      const phone = contact?.phone ? contact.phone.replace(/\D/g, "") : "";
      const fileName = `comprovante-${order.order_code}.pdf`;
      const blob = await buildPdfBlob();
      const file = new File([blob], fileName, { type: "application/pdf" });

      // The Web Share API is the only way a browser can hand WhatsApp
      // an actual file — a wa.me link only ever carries text, it can't
      // attach anything. Where it's unsupported (most desktop
      // browsers), fall back to downloading the PDF plus opening
      // WhatsApp with the text version, so the user can attach the
      // file by hand instead of getting nothing.
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: t("title"), text: receiptText() });
          return;
        } catch (err) {
          if ((err as Error)?.name === "AbortError") return;
        }
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);

      const text = encodeURIComponent(receiptText());
      const waUrl = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
      window.open(waUrl, "_blank", "noopener,noreferrer");
      toast.message(t("pdfDownloadedAttachManually"));
    } catch {
      toast.error(t("toastShareFailed"));
    } finally {
      setSharing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-1.5rem)] max-w-lg gap-0 overflow-hidden p-0 sm:w-[95vw]">
        <DialogHeader className="shrink-0 border-b border-border px-5 pt-5 pr-12 pb-4">
          <DialogTitle className="truncate">
            {t("title")} #{order.order_code}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          <div className="print-only-area px-5 py-4">
            <div className="flex items-center gap-3 border-b border-border pb-4 text-left">
              {branding?.logo_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={branding.logo_url} alt={branding.name} className="h-16 w-16 shrink-0 rounded-lg border border-border bg-white object-contain p-1" />
              )}
              <div className="min-w-0"><p className="truncate text-lg font-bold text-foreground">{branding?.name ?? "…"}</p>{branding?.legal_name && branding.legal_name !== branding.name && <p className="text-xs text-muted-foreground">{branding.legal_name}</p>}{branding?.cnpj && <p className="mt-1 text-xs font-medium text-foreground">CNPJ: {formatCnpj(branding.cnpj)}</p>}</div>
            </div>

            <div className="mt-4 rounded-lg bg-muted/50 p-3">
              <div className="flex items-start justify-between gap-3"><div><p className="text-xs text-muted-foreground">{t('orderRef')}</p><p className="text-lg font-bold text-foreground">#{order.order_code}</p></div><div className="text-right"><p className="text-xs text-muted-foreground">{t('date')}</p><p className="text-xs font-medium text-foreground">{date}</p></div></div>
              {contact && <div className="mt-3 border-t border-border pt-2"><p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t('customer')}</p><p className="text-sm font-medium text-foreground">{contact.name || contact.phone}</p>{contact.name && contact.phone && <p className="text-xs text-muted-foreground">{contact.phone}</p>}</div>}
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

            {(historyLoading || sortedHistory.length > 0) && (
              <div className="mt-4 border-t border-dashed border-border pt-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <History className="h-3.5 w-3.5" />
                  {t("historyTitle")}
                </p>
                {historyLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <ul className="space-y-1.5">
                    {sortedHistory.map((event) => (
                      <li key={event.id} className="text-xs text-muted-foreground">
                        <span className="text-foreground">{event.summary}</span>
                        <br />
                        {new Date(event.created_at).toLocaleString()}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <p className="mt-5 border-t border-border pt-3 text-center text-[10px] text-muted-foreground">{t('nonFiscalDocument')}</p>
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-border bg-popover p-4 sm:grid-cols-3">
          <Button variant="outline" size="sm" className="min-w-0 gap-1.5" onClick={copyText}>
            <Copy className="h-3.5 w-3.5" />
            {t("copy")}
          </Button>
          <Button variant="outline" size="sm" className="min-w-0 gap-1.5" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" />
            {t("print")}
          </Button>
          <Button size="sm" className="col-span-2 min-w-0 gap-1.5 sm:col-span-1" onClick={shareOnWhatsApp} disabled={sharing}>
            {sharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
            {t("shareWhatsapp")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
