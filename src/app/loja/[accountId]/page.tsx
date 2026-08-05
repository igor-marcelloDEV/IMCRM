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
import { ClipboardList, CreditCard, Headphones, Loader2, Minus, Package, Plus, QrCode, Search, ShieldCheck, ShoppingCart, Store, Truck, X, Zap } from 'lucide-react';

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
  offer_type: 'physical_product' | 'service' | 'subscription';
  billing_cycle: 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUALLY' | 'YEARLY' | null;
  compare_at_price_cents: number | null;
  trial_days: number;
  campaign_badge: string | null;
}

interface StoreData {
  account: {
    id: string;
    name: string;
    legal_name: string | null;
    cnpj: string | null;
    logo_url: string | null;
    store_slug: string | null;
  };
  catalog_items: StoreCatalogItem[];
}

interface RecentOrder {
  id: string; order_code: string; status: string; total_cents: number; currency: string; created_at: string;
}

function formatCnpj(value: string) {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 14) return value;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
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
  const [form, setForm] = useState({ name: '', phone: '', email: '', cpf_cnpj: '', delivery_address: '' });
  const [paymentMethod, setPaymentMethod] = useState<'pix' | 'card'>('pix');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'featured' | 'lowest' | 'highest'>('featured');
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [orderIdentifier, setOrderIdentifier] = useState('');
  const [recentOrders, setRecentOrders] = useState<RecentOrder[] | null>(null);
  const [lookingUpOrders, setLookingUpOrders] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    fetch(`/api/public/store/${accountId}`, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('not_found');
        return res.json();
      })
      .then((data: StoreData) => {
        setStore(data);
        if (data.account.store_slug && accountId !== data.account.store_slug) {
          router.replace(`/loja/${data.account.store_slug}`);
        }
      })
      .catch(() => setLoadError(true));
  }, [accountId, router]);

  const setQty = useCallback((itemId: string, qty: number) => {
    setCart((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[itemId];
      else next[itemId] = qty;
      return next;
    });
  }, []);

  const items = useMemo(() => store?.catalog_items ?? [], [store]);
  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = query
      ? items.filter((item) => `${item.name} ${item.description ?? ''}`.toLocaleLowerCase().includes(query))
      : [...items];
    if (sort === 'lowest') filtered.sort((a, b) => a.price_cents - b.price_cents);
    if (sort === 'highest') filtered.sort((a, b) => b.price_cents - a.price_cents);
    return filtered;
  }, [items, search, sort]);
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
  const checkoutReady = useMemo(() => {
    const phoneDigits = form.phone.replace(/\D/g, '');
    const taxDigits = form.cpf_cnpj.replace(/\D/g, '');
    const requiresAddress = cartLines.some((line) => line.item.offer_type === 'physical_product');
    return (
      form.name.trim().length > 1 &&
      phoneDigits.length >= 10 &&
      phoneDigits.length <= 13 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) &&
      (taxDigits.length === 11 || taxDigits.length === 14) && (!requiresAddress || form.delivery_address.trim().length >= 10)
    );
  }, [cartLines, form]);

  const submitCheckout = useCallback(async () => {
    if (!accountId) return;
    if (!checkoutReady) {
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
          payment_method: paymentMethod,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('toastCheckoutFailed'));
        return;
      }
      if (typeof data.payment_url === 'string' && data.payment_url.startsWith('https://')) {
        window.location.assign(data.payment_url);
      } else {
        router.push(`/loja/${accountId}/pedido/${data.order_id}`);
      }
    } catch {
      toast.error(t('toastCheckoutFailed'));
    } finally {
      setSubmitting(false);
    }
  }, [accountId, cartLines, checkoutReady, form, paymentMethod, router, t]);

  const lookupOrders = useCallback(async () => {
    if (!accountId || !orderIdentifier.trim()) return;
    setLookingUpOrders(true);
    try {
      const response = await fetch(`/api/public/store/${accountId}/orders/lookup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: orderIdentifier }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return void toast.error(data.error ?? t('orderLookupError'));
      setRecentOrders(data.orders ?? []);
    } finally { setLookingUpOrders(false); }
  }, [accountId, orderIdentifier, t]);

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
    <div className="min-h-screen bg-[#f5f5f5] pb-28 text-slate-900 dark:bg-background dark:text-foreground">
      <header className="sticky top-0 z-30 border-b border-blue-700/20 bg-blue-600 shadow-sm">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 lg:flex-nowrap">
          {store.account.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={store.account.logo_url}
              alt={store.account.name}
              className="h-11 w-11 shrink-0 rounded-xl border border-white/20 bg-white object-cover"
            />
          ) : (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/15">
              <Store className="h-6 w-6 text-white" />
            </div>
          )}
          <div className="min-w-0 shrink-0">
            <h1 className="max-w-52 truncate text-base font-bold text-white">{store.account.name}</h1>
            <p className="text-[11px] text-blue-100">
              {store.account.cnpj ? `CNPJ ${formatCnpj(store.account.cnpj)}` : t('officialStore')}
            </p>
          </div>
          <div className="order-last flex w-full flex-1 items-center rounded-lg bg-white shadow-sm lg:order-none lg:ml-5 lg:max-w-2xl">
            <Search className="ml-3 h-4 w-4 text-slate-400" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('searchPlaceholder')} className="h-11 w-full bg-transparent px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400" />
          </div>
          <button type="button" onClick={() => setOrdersOpen(true)} className="flex h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-white transition hover:bg-white/10">
            <ClipboardList className="h-5 w-5" /><span className="hidden sm:inline">{t('myOrders')}</span>
          </button>
          <button type="button" onClick={() => totalCount > 0 && setCheckoutOpen(true)} className="relative ml-auto flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-white transition hover:bg-white/10">
            <ShoppingCart className="h-5 w-5" /><span className="hidden sm:inline">{t('cart')}</span>
            {totalCount > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[11px] font-bold text-slate-900">{totalCount}</span>}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-5 sm:py-7">
        <section className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-blue-700 via-blue-600 to-cyan-500 px-6 py-8 text-white shadow-lg sm:px-10 sm:py-10">
          <div className="relative z-10 max-w-xl">
            <span className="inline-flex rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur">{t('heroBadge')}</span>
            <h2 className="mt-4 text-2xl font-black tracking-tight sm:text-4xl">{t('heroTitle')}</h2>
            <p className="mt-3 max-w-lg text-sm leading-6 text-blue-50 sm:text-base">{t('heroDescription')}</p>
            <button type="button" onClick={() => document.getElementById('products')?.scrollIntoView({ behavior: 'smooth' })} className="mt-5 rounded-lg bg-white px-5 py-2.5 text-sm font-bold text-blue-700 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">{t('viewOffers')}</button>
          </div>
          <div className="absolute -right-14 -top-20 h-64 w-64 rounded-full bg-white/10" /><div className="absolute -bottom-28 right-24 h-64 w-64 rounded-full bg-cyan-300/15" />
        </section>

        <section className="grid overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-border dark:bg-card sm:grid-cols-2 lg:grid-cols-4">
          {[{ icon: ShieldCheck, title: t('benefitSecure'), text: t('benefitSecureText') }, { icon: Zap, title: t('benefitFast'), text: t('benefitFastText') }, { icon: CreditCard, title: t('benefitPayment'), text: t('benefitPaymentText') }, { icon: Headphones, title: t('benefitSupport'), text: t('benefitSupportText') }].map((benefit) => (
            <div key={benefit.title} className="flex items-center gap-3 border-b border-slate-100 p-4 last:border-0 dark:border-border sm:border-r lg:border-b-0">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-500/10"><benefit.icon className="h-5 w-5" /></div>
              <div><p className="text-sm font-bold text-slate-900 dark:text-foreground">{benefit.title}</p><p className="text-xs text-slate-500 dark:text-muted-foreground">{benefit.text}</p></div>
            </div>
          ))}
        </section>

        <section id="products" className="scroll-mt-28">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div><p className="text-xs font-semibold uppercase tracking-widest text-blue-600">{t('catalogLabel')}</p><h2 className="mt-1 text-2xl font-bold text-slate-900 dark:text-foreground">{search ? t('searchResults') : t('featuredProducts')}</h2><p className="mt-1 text-sm text-slate-500 dark:text-muted-foreground">{t('productsFound', { count: visibleItems.length })}</p></div>
            <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-blue-500 dark:border-border dark:bg-card dark:text-foreground"><option value="featured">{t('sortFeatured')}</option><option value="lowest">{t('sortLowest')}</option><option value="highest">{t('sortHighest')}</option></select>
          </div>
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : visibleItems.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center dark:border-border dark:bg-card"><Search className="mx-auto h-8 w-8 text-slate-400" /><p className="mt-3 text-sm font-medium">{t('noSearchResults')}</p></div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleItems.map((item) => {
              const qty = cart[item.id] ?? 0;
              const outOfStock = item.stock_quantity !== null && item.stock_quantity <= 0;
              const maxQty = item.stock_quantity ?? Infinity;
              return (
                <article key={item.id} className="group overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition duration-200 hover:-translate-y-1 hover:shadow-xl dark:border-border dark:bg-card">
                  <div className="relative aspect-[4/3] overflow-hidden bg-slate-50 dark:bg-muted">
                  {item.media_url ? (
                    item.media_type === 'video' ? (
                      <video src={item.media_url} className="h-full w-full object-cover transition duration-300 group-hover:scale-105" muted />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.media_url} alt={item.name} className="h-full w-full object-cover transition duration-300 group-hover:scale-105" loading="lazy" />
                    )
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-slate-300 dark:text-muted-foreground"><Package className="h-14 w-14" /></div>
                  )}
                  <span className="absolute left-3 top-3 rounded-md bg-emerald-500 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow">{item.campaign_badge || (item.offer_type === 'subscription' ? 'ASSINATURA' : item.stock_quantity === null ? t('availableNow') : t('unitsAvailable', { count: item.stock_quantity }))}</span>
                  </div>
                  <div className="flex min-h-52 flex-col p-4">
                    <div className="flex-1">
                      <p className="line-clamp-2 text-base font-semibold leading-5 text-slate-800 dark:text-foreground">{item.name}</p>
                      {item.description && (
                        <p className="mt-2 line-clamp-2 text-sm leading-5 text-slate-500 dark:text-muted-foreground">{item.description}</p>
                      )}
                    </div>
                    <div className="mt-5"><p className="text-xs text-slate-400">{item.offer_type === 'subscription' ? 'Plano recorrente' : t('priceLabel')}</p>{item.compare_at_price_cents && <p className="text-xs text-slate-400 line-through">{formatCurrency(item.compare_at_price_cents / 100, item.currency)}</p>}<span className="text-2xl font-bold tracking-tight text-slate-900 dark:text-foreground">
                        {formatCurrency(item.price_cents / 100, item.currency)}
                      </span>{item.offer_type === 'subscription' && <span className="ml-1 text-xs text-slate-500">/{item.billing_cycle === 'YEARLY' ? 'ano' : item.billing_cycle === 'SEMIANNUALLY' ? 'semestre' : item.billing_cycle === 'QUARTERLY' ? 'trimestre' : 'mês'}</span>}<p className="mt-1 flex items-center gap-1 text-xs font-medium text-emerald-600"><Truck className="h-3.5 w-3.5" />{item.offer_type === 'subscription' && item.trial_days > 0 ? `${item.trial_days} dias grátis` : t('deliveryTracking')}</p></div>
                    <div className="mt-4 flex items-center justify-between gap-2">
                      {outOfStock ? (
                        <span className="text-xs font-medium text-red-400">{t('outOfStock')}</span>
                      ) : qty === 0 ? (
                        <Button className="w-full" onClick={() => setQty(item.id, 1)}>
                          <Plus className="mr-1 h-3.5 w-3.5" />
                          {t('add')}
                        </Button>
                      ) : (
                        <div className="grid h-11 w-full grid-cols-[40px_minmax(0,1fr)_40px] items-center overflow-hidden rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-500/30 dark:bg-blue-500/10">
                          <button type="button" aria-label={t('decreaseQuantity')} className="flex h-full w-10 items-center justify-center border-r border-blue-200 text-blue-700 hover:bg-blue-100 dark:border-blue-500/30 dark:text-blue-300" onClick={() => setQty(item.id, qty - 1)}>
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <span className="truncate px-1 text-center text-sm font-bold text-blue-700 dark:text-blue-300">{qty} {t('inCart')}</span>
                          <button type="button" aria-label={t('increaseQuantity')} className="flex h-full w-10 items-center justify-center border-l border-blue-200 text-blue-700 hover:bg-blue-100 disabled:opacity-40 dark:border-blue-500/30 dark:text-blue-300" onClick={() => setQty(item.id, Math.min(qty + 1, maxQty))} disabled={qty >= maxQty}>
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        </section>
      </main>

      {totalCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 shadow-[0_-8px_30px_rgba(0,0,0,0.08)] backdrop-blur dark:border-border dark:bg-card/95">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-foreground">
              <ShoppingCart className="h-4 w-4 text-muted-foreground" />
              {t('cartCount', { count: totalCount })}
              <span className="font-semibold">{formatCurrency(totalCents / 100, currency)}</span>
            </div>
            <Button size="lg" onClick={() => setCheckoutOpen(true)}>{t('checkoutButton')}</Button>
          </div>
        </div>
      )}

      <Dialog open={checkoutOpen} onOpenChange={setCheckoutOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
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
                required
                aria-required="true"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t('phoneLabel')}</label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="(11) 91234-5678"
                inputMode="tel"
                required
                aria-required="true"
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
                aria-required="true"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t('cpfLabel')}</label>
              <Input
                value={form.cpf_cnpj}
                onChange={(e) => setForm({ ...form, cpf_cnpj: e.target.value })}
                placeholder={t('cpfPlaceholder')}
                inputMode="numeric"
                required
                aria-required="true"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">{t('cpfHint')}</p>
            </div>
            {cartLines.some((line) => line.item.offer_type === 'physical_product') && <div><label className="mb-1 block text-xs text-muted-foreground">Endereço completo para entrega *</label><Input value={form.delivery_address} onChange={(e) => setForm({ ...form, delivery_address: e.target.value })} placeholder="Rua, número, bairro, cidade e complemento" required /></div>}
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-foreground">{t('paymentMethod')}</legend>
            <button type="button" onClick={() => setPaymentMethod('pix')} className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left ${paymentMethod === 'pix' ? 'border-primary bg-primary/5' : 'border-border'}`}>
              <QrCode className="h-5 w-5 text-primary" />
              <span><span className="block text-sm font-medium text-foreground">PIX</span><span className="block text-xs text-muted-foreground">{t('pixMethodHint')}</span></span>
            </button>
            <button type="button" onClick={() => setPaymentMethod('card')} className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left ${paymentMethod === 'card' ? 'border-primary bg-primary/5' : 'border-border'}`}>
              <CreditCard className="h-5 w-5 text-primary" />
              <span><span className="block text-sm font-medium text-foreground">{t('cardMethod')}</span><span className="block text-xs text-muted-foreground">{t('cardMethodHint')}</span></span>
            </button>
          </fieldset>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCheckoutOpen(false)} disabled={submitting}>
              {t('cancel')}
            </Button>
            <Button onClick={submitCheckout} disabled={submitting || !checkoutReady}>
              {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t('confirmOrder')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={ordersOpen} onOpenChange={setOrdersOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{t('myOrders')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('orderLookupHelp')}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={orderIdentifier} onChange={(event) => setOrderIdentifier(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void lookupOrders()} placeholder={t('orderLookupPlaceholder')} />
            <Button className="sm:w-auto" onClick={lookupOrders} disabled={lookingUpOrders || !orderIdentifier.trim()}>
              {lookingUpOrders ? <Loader2 className="h-4 w-4 animate-spin" /> : t('searchOrders')}
            </Button>
          </div>
          {recentOrders !== null && <div className="space-y-2">
            {recentOrders.length === 0 ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t('noOrdersFound')}</p> : recentOrders.map((order) => (
              <button key={order.id} type="button" onClick={() => router.push(`/loja/${accountId}/pedido/${order.id}`)} className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-left transition hover:border-primary hover:bg-muted/50">
                <span className="min-w-0"><strong className="block text-sm">Pedido #{order.order_code}</strong><span className="block truncate text-xs text-muted-foreground">{new Date(order.created_at).toLocaleDateString('pt-BR')} · {order.status.replaceAll('_', ' ')}</span></span>
                <strong className="shrink-0 text-sm">{formatCurrency(order.total_cents / 100, order.currency)}</strong>
              </button>
            ))}
          </div>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
