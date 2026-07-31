'use client';

// ============================================================
// /loja/[accountId] — public storefront.
//
// Unauthenticated by design: a tenant shares this link directly with
// a customer (WhatsApp, Instagram bio, wherever) so they can build a
// cart and pay without needing an open chat window — the workaround
// for the Meta 24h/template restriction that blocks a tenant from
// messaging a lead first. Everything here reads/writes through
// /api/public/store/*, which uses the service-role client and
// revalidates price/stock server-side; nothing here is trusted input.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Minus, Package, Plus, ShoppingCart, Store, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/currency';

interface StoreCatalogItem {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  media_url: string | null;
  media_type: 'image' | 'video' | null;
  stock_quantity: number | null;
}

interface StoreData {
  account: { id: string; name: string; logo_url: string | null };
  catalog_items: StoreCatalogItem[];
}

export default function PublicStorePage() {
  const t = useTranslations('PublicStore');
  const params = useParams<{ accountId: string }>();
  const accountId = params?.accountId;
  const router = useRouter();

  const [store, setStore] = useState<StoreData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', cpf_cnpj: '' });

  useEffect(() => {
    if (!accountId) return;
    fetch(`/api/public/store/${accountId}`, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('not_found');
        return res.json();
      })
      .then((data) => setStore(data))
      .catch(() => setLoadError(true));
  }, [accountId]);

  const setQty = useCallback((itemId: string, qty: number) => {
    setCart((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[itemId];
      else next[itemId] = qty;
      return next;
    });
  }, []);

  const items = store?.catalog_items ?? [];
  const cartLines = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, qty]) => ({ item: items.find((i) => i.id === id), qty }))
        .filter((l): l is { item: StoreCatalogItem; qty: number } => !!l.item),
    [cart, items],
  );
  const totalCents = cartLines.reduce((sum, l) => sum + l.item.price_cents * l.qty, 0);
  const totalCount = cartLines.reduce((sum, l) => sum + l.qty, 0);
  const currency = items[0]?.currency ?? 'BRL';

  const submitCheckout = useCallback(async () => {
    if (!accountId) return;
    if (!form.name.trim() || !form.phone.trim() || !form.email.trim()) {
      toast.error(t('toastMissingFields'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/store/${accountId}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cartLines.map((l) => ({ catalog_item_id: l.item.id, quantity: l.qty })),
          customer: form,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('toastCheckoutFailed'));
        return;
      }
      router.push(`/loja/${accountId}/pedido/${data.order_id}`);
    } catch {
      toast.error(t('toastCheckoutFailed'));
    } finally {
      setSubmitting(false);
    }
  }, [accountId, cartLines, form, router, t]);

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-28">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-5">
          {store.account.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={store.account.logo_url}
              alt={store.account.name}
              className="h-12 w-12 shrink-0 rounded-lg object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Store className="h-6 w-6 text-primary" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-foreground">{store.account.name}</h1>
            <p className="text-xs text-muted-foreground">{t('tagline')}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6">
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {items.map((item) => {
              const qty = cart[item.id] ?? 0;
              const outOfStock = item.stock_quantity !== null && item.stock_quantity <= 0;
              const maxQty = item.stock_quantity ?? Infinity;
              return (
                <div
                  key={item.id}
                  className="flex gap-3 rounded-lg border border-border bg-card p-3"
                >
                  {item.media_url ? (
                    item.media_type === 'video' ? (
                      <video src={item.media_url} className="h-20 w-20 shrink-0 rounded-md object-cover" muted />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.media_url} alt="" className="h-20 w-20 shrink-0 rounded-md object-cover" />
                    )
                  ) : (
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Package className="h-6 w-6" />
                    </div>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col justify-between">
                    <div>
                      <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
                      {item.description && (
                        <p className="line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
                      )}
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-sm font-semibold text-foreground">
                        {formatCurrency(item.price_cents / 100, item.currency)}
                      </span>
                      {outOfStock ? (
                        <span className="text-xs font-medium text-red-400">{t('outOfStock')}</span>
                      ) : qty === 0 ? (
                        <Button size="sm" onClick={() => setQty(item.id, 1)}>
                          <Plus className="mr-1 h-3.5 w-3.5" />
                          {t('add')}
                        </Button>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="icon-sm"
                            onClick={() => setQty(item.id, qty - 1)}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </Button>
                          <span className="w-5 text-center text-sm font-medium text-foreground">{qty}</span>
                          <Button
                            variant="outline"
                            size="icon-sm"
                            onClick={() => setQty(item.id, Math.min(qty + 1, maxQty))}
                            disabled={qty >= maxQty}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {totalCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-card/95 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-foreground">
              <ShoppingCart className="h-4 w-4 text-muted-foreground" />
              {t('cartCount', { count: totalCount })}
              <span className="font-semibold">{formatCurrency(totalCents / 100, currency)}</span>
            </div>
            <Button onClick={() => setCheckoutOpen(true)}>{t('checkoutButton')}</Button>
          </div>
        </div>
      )}

      <Dialog open={checkoutOpen} onOpenChange={setCheckoutOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('checkoutTitle')}</DialogTitle>
          </DialogHeader>

          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/40 p-2">
            {cartLines.map((l) => (
              <div key={l.item.id} className="flex items-center justify-between text-xs">
                <span className="truncate text-foreground">
                  {l.qty}x {l.item.name}
                </span>
                <div className="flex items-center gap-2 text-muted-foreground">
                  {formatCurrency((l.item.price_cents * l.qty) / 100, l.item.currency)}
                  <button
                    type="button"
                    onClick={() => setQty(l.item.id, 0)}
                    className="text-muted-foreground hover:text-red-400"
                    aria-label={t('removeItem')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between text-sm font-semibold text-foreground">
            <span>{t('total')}</span>
            <span>{formatCurrency(totalCents / 100, currency)}</span>
          </div>

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t('nameLabel')}</label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('namePlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t('phoneLabel')}</label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="(11) 91234-5678"
                inputMode="tel"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t('emailLabel')}</label>
              <Input
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="voce@email.com"
                type="email"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t('cpfLabel')}</label>
              <Input
                value={form.cpf_cnpj}
                onChange={(e) => setForm({ ...form, cpf_cnpj: e.target.value })}
                placeholder={t('cpfPlaceholder')}
                inputMode="numeric"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">{t('cpfHint')}</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCheckoutOpen(false)} disabled={submitting}>
              {t('cancel')}
            </Button>
            <Button onClick={submitCheckout} disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t('confirmOrder')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
