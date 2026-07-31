"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FileText, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

interface InvoiceCardProps {
  orderId: string;
  invoiceStatus: string | null;
}

/**
 * "Ver NF" card — shared by the deal panel and the order/comanda
 * panel so the two don't drift. Asaas issues the NFS-e asynchronously
 * after `scheduleInvoice` (orders webhook), so the PDF isn't ready at
 * payment time; this queries Asaas live on click rather than trusting
 * a cached status.
 */
export function InvoiceCard({ orderId, invoiceStatus: initialStatus }: InvoiceCardProps) {
  const t = useTranslations("Orders.invoice");
  const [status, setStatus] = useState(initialStatus);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function check() {
    setLoading(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/invoice`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("toastFailed"));
        return;
      }
      setStatus(data.status ?? null);
      if (data.pdf_url) {
        setPdfUrl(data.pdf_url as string);
        window.open(data.pdf_url as string, "_blank", "noopener,noreferrer");
      } else {
        toast.info(t("notReadyYet", { status: data.status ?? "" }));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex items-center gap-2 text-xs">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <div>
          <p className="font-medium text-foreground">{t("title")}</p>
          <p className="text-muted-foreground">
            {t(`status.${status ?? "SCHEDULED"}`, { defaultValue: status ?? "" })}
          </p>
          {pdfUrl && (
            <a
              href={pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {t("downloadPdf")}
            </a>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={check}
        className="h-7 shrink-0 gap-1 text-xs"
      >
        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
        {t("view")}
      </Button>
    </div>
  );
}
