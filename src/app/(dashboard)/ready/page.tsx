'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, Loader2, PackageCheck, RefreshCw, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

type FulfillmentStatus = 'awaiting_payment' | 'confirmed' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered';
interface Row {
  id: string; order_code: string; contact_id: string | null; fulfillment_status: FulfillmentStatus;
  fulfillment_updated_at: string; fulfillment_type: 'pickup' | 'delivery' | null;
  assigned_driver_id: string | null; delivery_neighborhood: string | null; delivery_city: string | null;
}
interface Item { order_id: string; name_snapshot: string; quantity: number }
interface Contact { id: string; name: string | null; phone: string }
interface DriverRef { id: string; name: string }

const REFRESH_MS = 20_000;

function ageMinutes(date: string) { return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60_000)); }
function ageLabel(minutes: number) { return minutes < 1 ? 'agora' : minutes < 60 ? `há ${minutes} min` : `há ${Math.floor(minutes / 60)}h`; }

export default function ReadyPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [drivers, setDrivers] = useState<DriverRef[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/fulfillment', { cache: 'no-store' });
    if (!response.ok) { toast.error('Não foi possível carregar os pedidos.'); return; }
    const data = await response.json();
    setRows(data.orders);
    setItems(data.items);
    setContacts(data.contacts);
    setDrivers(data.drivers ?? []);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const contactMap = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const driverMap = useMemo(() => new Map(drivers.map((d) => [d.id, d])), [drivers]);
  const itemMap = useMemo(() => {
    const map = new Map<string, Item[]>();
    items.forEach((item) => map.set(item.order_id, [...(map.get(item.order_id) ?? []), item]));
    return map;
  }, [items]);

  const pickupReady = useMemo(
    () => (rows ?? []).filter((row) => row.fulfillment_type === 'pickup' && row.fulfillment_status === 'ready'),
    [rows],
  );
  const deliveryReady = useMemo(
    () => (rows ?? []).filter((row) => row.fulfillment_type === 'delivery' && row.fulfillment_status === 'ready'),
    [rows],
  );
  const deliveryOutForDelivery = useMemo(
    () => (rows ?? []).filter((row) => row.fulfillment_type === 'delivery' && row.fulfillment_status === 'out_for_delivery'),
    [rows],
  );

  const advance = async (orderId: string, status: FulfillmentStatus) => {
    setSaving(orderId);
    const response = await fetch('/api/fulfillment', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId, fulfillment_status: status }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) toast.error(data.error ?? 'Não foi possível atualizar o pedido.');
    else setRows((current) => current?.map((row) => (row.id === orderId ? { ...row, fulfillment_status: status, fulfillment_updated_at: new Date().toISOString() } : row)) ?? null);
    setSaving(null);
  };

  const OrderCard = ({ order, action, actionLabel }: { order: Row; action?: FulfillmentStatus; actionLabel?: string }) => {
    const contact = order.contact_id ? contactMap.get(order.contact_id) : null;
    const driver = order.assigned_driver_id ? driverMap.get(order.assigned_driver_id) : null;
    const age = ageMinutes(order.fulfillment_updated_at);
    return (
      <Card key={order.id} className={age >= 20 ? 'border-amber-500/50' : undefined}>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-lg font-bold text-foreground">Pedido #{order.order_code}</p>
              <p className="text-xs text-muted-foreground">{contact?.name ?? 'Cliente'} · {contact?.phone ?? ''}</p>
            </div>
            <span className={`shrink-0 text-[11px] ${age >= 20 ? 'font-semibold text-amber-400' : 'text-muted-foreground'}`}>
              <Clock3 className="mr-1 inline h-3 w-3" />{ageLabel(age)}
            </span>
          </div>
          {order.fulfillment_type === 'delivery' && (
            <div className="flex items-center gap-1.5 rounded-md bg-blue-500/10 px-2 py-1 text-[11px] text-blue-400">
              <Truck className="h-3 w-3 shrink-0" />
              {driver ? <span>{driver.name}</span> : <span>Aguardando entregador</span>}
              {(order.delivery_neighborhood || order.delivery_city) && (
                <span className="truncate text-blue-400/70">· {[order.delivery_neighborhood, order.delivery_city].filter(Boolean).join(', ')}</span>
              )}
            </div>
          )}
          <ul className="space-y-1 text-sm text-foreground">
            {(itemMap.get(order.id) ?? []).map((item, index) => (
              <li key={index}>{item.quantity}x {item.name_snapshot}</li>
            ))}
          </ul>
          {action && actionLabel && (
            <Button size="lg" className="w-full text-base" disabled={saving === order.id} onClick={() => void advance(order.id, action)}>
              {saving === order.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {actionLabel}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <PackageCheck className="h-6 w-6 text-primary" />
            Prontos — entrega e retirada
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Pedidos que saíram da cozinha. Confirme a retirada do cliente ou o despacho pro entregador.</p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Atualizar
        </Button>
      </div>

      {rows === null ? (
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <section className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-2 text-base font-semibold text-foreground">
              <PackageCheck className="h-5 w-5 text-violet-400" />
              Prontos para retirada
              <span className="ml-auto rounded-full bg-muted px-2.5 py-0.5 text-sm text-muted-foreground">{pickupReady.length}</span>
            </div>
            {pickupReady.length === 0 && <div className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">Nenhum pedido esperando o cliente.</div>}
            <div className="space-y-3">
              {pickupReady.map((order) => <OrderCard key={order.id} order={order} action="delivered" actionLabel="Cliente retirou" />)}
            </div>
          </section>

          <section className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Truck className="h-5 w-5 text-blue-400" />
              Prontos para despachar
              <span className="ml-auto rounded-full bg-muted px-2.5 py-0.5 text-sm text-muted-foreground">{deliveryReady.length}</span>
            </div>
            {deliveryReady.length === 0 && <div className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">Nenhum pedido esperando entregador.</div>}
            <div className="space-y-3">
              {deliveryReady.map((order) => <OrderCard key={order.id} order={order} action="out_for_delivery" actionLabel="Saiu para entrega" />)}
            </div>
          </section>

          <section className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-2 text-base font-semibold text-foreground">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              Em rota de entrega
              <span className="ml-auto rounded-full bg-muted px-2.5 py-0.5 text-sm text-muted-foreground">{deliveryOutForDelivery.length}</span>
            </div>
            {deliveryOutForDelivery.length === 0 && <div className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">Nenhuma entrega em rota agora.</div>}
            <div className="space-y-3">
              {deliveryOutForDelivery.map((order) => <OrderCard key={order.id} order={order} action="delivered" actionLabel="Confirmar entrega" />)}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
