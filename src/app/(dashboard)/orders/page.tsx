'use client';

// Orders placed through the checkout Flow node, plus comandas opened
// directly here (source: 'manual') — the "dashboard de pagamentos
// realizados" (completed-payments dashboard) AND the place to run a
// counter sale. Normal tenant page (RLS-scoped via the client, no
// operator gate) — every account member can see their own account's
// orders; clicking a row opens the operable detail panel.

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CircleDollarSign, Eye, EyeOff, Lightbulb, Package, Plus, UserRoundX } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Order, OrderStatus } from '@/types';
import { NewOrderDialog } from '@/components/orders/new-order-dialog';
import { OrderDetailSheet } from '@/components/orders/order-detail-sheet';

interface OrderRow extends Order {
  contactName: string | null;
  itemCount: number;
  itemsSummary: string;
  pipelineName: string | null;
  stageName: string | null;
}

const HIDE_REVENUE_STORAGE_KEY = 'imcrm.orders.hideRevenue';

function statusVariant(
  status: OrderStatus
): 'default' | 'secondary' | 'outline' {
  if (status === 'paid') return 'default';
  if (status === 'pending_payment') return 'secondary';
  return 'outline';
}

export default function OrdersPage() {
  const t = useTranslations('Orders');
  const { accountId } = useAuth();
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [newOrderOpen, setNewOrderOpen] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [hideRevenue, setHideRevenue] = useState(false);

  useEffect(() => {
    setHideRevenue(window.localStorage.getItem(HIDE_REVENUE_STORAGE_KEY) === '1');
  }, []);

  const toggleHideRevenue = useCallback(() => {
    setHideRevenue((prev) => {
      const next = !prev;
      window.localStorage.setItem(HIDE_REVENUE_STORAGE_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const { data: orderRows } = await supabase
      .from('orders')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(100);
    const rows = (orderRows as Order[] | null) ?? [];
    if (rows.length === 0) {
      setOrders([]);
      return;
    }

    // Two follow-up queries rather than an embedded select — keeps
    // this robust against PostgREST schema-cache staleness right
    // after the migrations that added these tables (same rationale
    // as loadCartSummary in src/lib/flows/engine.ts).
    const contactIds = [
      ...new Set(
        rows
          .map((o) => o.contact_id)
          .filter((id): id is string => typeof id === 'string')
      ),
    ];
    const orderIds = rows.map((o) => o.id);
    const dealIds = rows.map((o) => o.deal_id).filter((id): id is string => !!id);
    const contactsQuery = contactIds.length
      ? supabase.from('contacts').select('id, name').in('id', contactIds)
      : Promise.resolve({
          data: [] as Array<{ id: string; name: string | null }>,
        });
    const [{ data: contacts }, { data: items }, { data: deals }] = await Promise.all([
      contactsQuery,
      supabase
        .from('order_items')
        .select('order_id, name_snapshot, quantity')
        .in('order_id', orderIds)
        .order('created_at', { ascending: true }),
      dealIds.length
        ? supabase.from('deals').select('id, pipeline:pipelines(name), stage:pipeline_stages(name)').in('id', dealIds)
        : Promise.resolve({ data: [] }),
    ]);

    const nameByContact = new Map(
      (
        (contacts as Array<{ id: string; name: string | null }> | null) ?? []
      ).map((c) => [c.id, c.name])
    );
    const itemsByOrder = new Map<string, Array<{ name_snapshot: string; quantity: number }>>();
    for (const it of (items as Array<{ order_id: string; name_snapshot: string; quantity: number }> | null) ?? []) {
      const list = itemsByOrder.get(it.order_id) ?? [];
      list.push({ name_snapshot: it.name_snapshot, quantity: it.quantity });
      itemsByOrder.set(it.order_id, list);
    }
    const dealById = new Map(
      ((deals as Array<{ id: string; pipeline: { name: string } | null; stage: { name: string } | null }> | null) ?? [])
        .map((deal) => [deal.id, deal]),
    );

    setOrders(
      rows.map((o) => {
        const orderItems = itemsByOrder.get(o.id) ?? [];
        const deal = o.deal_id ? dealById.get(o.deal_id) : null;
        return {
          ...o,
          contactName: o.contact_id
            ? (nameByContact.get(o.contact_id) ?? null)
            : null,
          itemCount: orderItems.length,
          itemsSummary: orderItems.map((i) => `${i.quantity}x ${i.name_snapshot}`).join(', '),
          pipelineName: deal?.pipeline?.name ?? null,
          stageName: deal?.stage?.name ?? null,
        };
      })
    );
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const orderId = new URLSearchParams(window.location.search).get('order');
    if (orderId) {
      setSelectedOrderId(orderId);
      setDetailOpen(true);
    }
  }, []);

  function openOrder(id: string) {
    setSelectedOrderId(id);
    setDetailOpen(true);
  }

  const paidCount = orders?.filter((o) => o.status === 'paid').length ?? 0;
  const paidTotalCents =
    orders
      ?.filter((o) => o.status === 'paid')
      .reduce((s, o) => s + o.total_cents, 0) ?? 0;
  const openCount = orders?.filter((o) => o.status === 'pending_payment').length ?? 0;
  const openTotalCents = orders?.filter((o) => o.status === 'pending_payment').reduce((sum, order) => sum + order.total_cents, 0) ?? 0;
  const averageTicketCents = paidCount > 0 ? Math.round(paidTotalCents / paidCount) : 0;
  const missingNameCount = orders?.filter((order) => !order.contactName || /^\+?\d[\d\s().-]+$/.test(order.contactName)).length ?? 0;
  const missingFunnelCount = orders?.filter((order) => !order.pipelineName || !order.stageName).length ?? 0;
  const orderInsights = [
    openCount > 0 ? t('insights.recoverPayments', { count: openCount, value: formatCurrency(openTotalCents / 100, 'BRL') }) : null,
    missingNameCount > 0 ? t('insights.fixNames', { count: missingNameCount }) : null,
    missingFunnelCount > 0 ? t('insights.fixFunnel', { count: missingFunnelCount }) : null,
  ].filter((insight): insight is string => !!insight);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            onClick={toggleHideRevenue}
            className="gap-1.5"
            title={hideRevenue ? t('showRevenue') : t('hideRevenue')}
          >
            {hideRevenue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {hideRevenue ? t('showRevenue') : t('hideRevenue')}
          </Button>
          <Button onClick={() => setNewOrderOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t('newOrder.button')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
              <Package className="h-5 w-5" />
            </div>
            <div>
              <p className="text-foreground text-2xl font-bold">{paidCount}</p>
              <p className="text-muted-foreground text-xs">{t('paidCount')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-lg">
              <Package className="h-5 w-5" />
            </div>
            <div>
              <p className={`text-foreground text-2xl font-bold ${hideRevenue ? 'blur-sm select-none' : ''}`}>
                {formatCurrency(paidTotalCents / 100, 'BRL')}
              </p>
              <p className="text-muted-foreground text-xs">{t('paidTotal')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
              <Package className="h-5 w-5" />
            </div>
            <div>
              <p className="text-foreground text-2xl font-bold">{openCount}</p>
              <p className="text-muted-foreground text-xs">{t('openCount')}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400"><CircleDollarSign className="h-5 w-5" /></div>
            <div><p className={`text-foreground text-2xl font-bold ${hideRevenue ? 'blur-sm select-none' : ''}`}>{formatCurrency(averageTicketCents / 100, 'BRL')}</p><p className="text-muted-foreground text-xs">{t('averageTicket')}</p></div>
          </CardContent>
        </Card>
      </div>

      <Card className={orderInsights.length ? 'border-amber-500/20 bg-amber-500/5' : 'border-emerald-500/20 bg-emerald-500/5'}>
        <CardContent className="flex gap-3 p-4">
          {orderInsights.length ? <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" /> : <Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />}
          <div><p className="text-sm font-semibold text-foreground">{t('insights.title')}</p>{orderInsights.length ? <ul className="mt-2 space-y-1 text-sm text-muted-foreground">{orderInsights.map((insight) => <li key={insight}>• <span className={hideRevenue && insight.includes('R$') ? 'blur-sm select-none' : ''}>{insight}</span></li>)}</ul> : <p className="mt-1 text-sm text-muted-foreground">{t('insights.healthy')}</p>}</div>
          {(missingNameCount > 0 || missingFunnelCount > 0) && <UserRoundX className="ml-auto h-5 w-5 text-muted-foreground" />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('listTitle')}</CardTitle>
          <CardDescription>{t('listDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {orders === null ? (
            <div className="bg-muted h-40 animate-pulse rounded-lg" />
          ) : orders.length === 0 ? (
            <p className="border-border text-muted-foreground rounded-lg border border-dashed py-10 text-center text-sm">
              {t('empty')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('colNumber')}</TableHead>
                    <TableHead>{t('colContact')}</TableHead>
                    <TableHead>{t('colItems')}</TableHead>
                    <TableHead>{t('colTotal')}</TableHead>
                    <TableHead>{t('colStatus')}</TableHead>
                    <TableHead>{t('colFunnel')}</TableHead>
                    <TableHead>{t('colFunnelStage')}</TableHead>
                    <TableHead>{t('colSource')}</TableHead>
                    <TableHead>{t('colDate')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((o) => (
                    <TableRow
                      key={o.id}
                      onClick={() => openOrder(o.id)}
                      className="cursor-pointer hover:bg-muted/50"
                    >
                      <TableCell className="text-muted-foreground font-mono text-xs">
                        #{o.order_code}
                      </TableCell>
                      <TableCell className="text-foreground font-medium">
                        {o.contactName ?? t('unknownContact')}
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-muted-foreground" title={o.itemsSummary}>
                        {o.itemsSummary || t('itemCount', { count: o.itemCount })}
                      </TableCell>
                      <TableCell className={hideRevenue ? 'blur-sm select-none' : undefined}>
                        {formatCurrency(o.total_cents / 100, o.currency)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(o.status)}>
                          {t(`status.${o.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-foreground">{o.pipelineName ?? '—'}</TableCell>
                      <TableCell><Badge variant="outline">{o.stageName ?? '—'}</Badge></TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {o.source === 'manual' ? t('sourceManual') : t('sourceWhatsapp')}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(o.created_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <NewOrderDialog
        open={newOrderOpen}
        onOpenChange={setNewOrderOpen}
        onCreated={(order) => {
          void load();
          openOrder(order.id);
        }}
      />

      <OrderDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        orderId={selectedOrderId}
        onSaved={() => void load()}
      />
    </div>
  );
}
