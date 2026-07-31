'use client';

// Orders placed through the checkout Flow node — the "dashboard de
// pagamentos realizados" (completed-payments dashboard). Normal
// tenant page (RLS-scoped via the client, no operator gate) — every
// account member can see their own account's orders.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Package } from 'lucide-react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Order, OrderStatus } from '@/types';

interface OrderRow extends Order {
  contactName: string | null;
  itemCount: number;
}

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

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const supabase = createClient();

    (async () => {
      const { data: orderRows } = await supabase
        .from('orders')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(100);
      const rows = (orderRows as Order[] | null) ?? [];
      if (cancelled || rows.length === 0) {
        if (!cancelled) setOrders([]);
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
      const contactsQuery = contactIds.length
        ? supabase.from('contacts').select('id, name').in('id', contactIds)
        : Promise.resolve({
            data: [] as Array<{ id: string; name: string | null }>,
          });
      const [{ data: contacts }, { data: items }] = await Promise.all([
        contactsQuery,
        supabase
          .from('order_items')
          .select('order_id')
          .in('order_id', orderIds),
      ]);
      if (cancelled) return;

      const nameByContact = new Map(
        (
          (contacts as Array<{ id: string; name: string | null }> | null) ?? []
        ).map((c) => [c.id, c.name])
      );
      const itemCountByOrder = new Map<string, number>();
      for (const it of (items as Array<{ order_id: string }> | null) ?? []) {
        itemCountByOrder.set(
          it.order_id,
          (itemCountByOrder.get(it.order_id) ?? 0) + 1
        );
      }

      setOrders(
        rows.map((o) => ({
          ...o,
          contactName: o.contact_id
            ? (nameByContact.get(o.contact_id) ?? null)
            : null,
          itemCount: itemCountByOrder.get(o.id) ?? 0,
        }))
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const paidCount = orders?.filter((o) => o.status === 'paid').length ?? 0;
  const paidTotalCents =
    orders
      ?.filter((o) => o.status === 'paid')
      .reduce((s, o) => s + o.total_cents, 0) ?? 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              <p className="text-foreground text-2xl font-bold">
                {formatCurrency(paidTotalCents / 100, 'BRL')}
              </p>
              <p className="text-muted-foreground text-xs">{t('paidTotal')}</p>
            </div>
          </CardContent>
        </Card>
      </div>

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
                    <TableHead>{t('colContact')}</TableHead>
                    <TableHead>{t('colItems')}</TableHead>
                    <TableHead>{t('colTotal')}</TableHead>
                    <TableHead>{t('colStatus')}</TableHead>
                    <TableHead>{t('colDeal')}</TableHead>
                    <TableHead>{t('colDate')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="text-foreground font-medium">
                        {o.contactName ?? t('unknownContact')}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {t('itemCount', { count: o.itemCount })}
                      </TableCell>
                      <TableCell>
                        {formatCurrency(o.total_cents / 100, o.currency)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(o.status)}>
                          {t(`status.${o.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {o.deal_id ? (
                          <Link
                            href="/pipelines"
                            className="text-primary hover:underline"
                          >
                            {t('viewDeal')}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
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
    </div>
  );
}
