'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChefHat, Clock3, Loader2, PackageCheck, RefreshCw, Soup, Truck, UtensilsCrossed } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

type FulfillmentStatus = 'awaiting_payment' | 'confirmed' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered';
interface Row { id: string; order_code: string; contact_id: string | null; fulfillment_status: FulfillmentStatus; fulfillment_updated_at: string; fulfillment_type: 'pickup' | 'delivery' | null; created_at: string }
interface Item { order_id: string; name_snapshot: string; quantity: number }
interface Contact { id: string; name: string | null; phone: string }

const REFRESH_MS = 20_000;

function ageMinutes(date: string) { return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60_000)); }
function ageLabel(minutes: number) { return minutes < 1 ? 'agora' : minutes < 60 ? `há ${minutes} min` : `há ${Math.floor(minutes / 60)}h`; }

const columns: Array<{ status: FulfillmentStatus; label: string; icon: typeof Soup; next?: FulfillmentStatus; action?: string; empty: string }> = [
  { status: 'confirmed', label: 'Para começar', icon: Soup, next: 'preparing', action: 'Iniciar preparo', empty: 'Nenhum pedido novo. 🎉' },
  { status: 'preparing', label: 'Na chapa / em preparo', icon: ChefHat, next: 'ready', action: 'Marcar como pronto', empty: 'Nada em preparo agora.' },
];

export default function KitchenPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/fulfillment', { cache: 'no-store' });
    if (!response.ok) { toast.error('Não foi possível carregar os pedidos.'); return; }
    const data = await response.json();
    setRows(data.orders);
    setItems(data.items);
    setContacts(data.contacts);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const contactMap = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const itemMap = useMemo(() => {
    const map = new Map<string, Item[]>();
    items.forEach((item) => map.set(item.order_id, [...(map.get(item.order_id) ?? []), item]));
    return map;
  }, [items]);

  const kitchenRows = useMemo(
    () => (rows ?? []).filter((row) => row.fulfillment_status === 'confirmed' || row.fulfillment_status === 'preparing'),
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <UtensilsCrossed className="h-6 w-6 text-primary" />
            Painel da cozinha
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Pedidos pagos esperando preparo. Toque para avançar a fase — sem preço, só o que importa pra cozinhar.</p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Atualizar
        </Button>
      </div>

      {rows === null ? (
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {columns.map((column) => {
            const Icon = column.icon;
            const matches = kitchenRows.filter((row) => row.fulfillment_status === column.status);
            return (
              <section key={column.status} className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/20 p-4">
                <div className="flex items-center gap-2 text-base font-semibold text-foreground">
                  <Icon className="h-5 w-5 text-primary" />
                  {column.label}
                  <span className="ml-auto rounded-full bg-muted px-2.5 py-0.5 text-sm text-muted-foreground">{matches.length}</span>
                </div>

                {matches.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">{column.empty}</div>
                )}

                <div className="space-y-3">
                  {matches
                    .slice()
                    .sort((a, b) => new Date(a.fulfillment_updated_at).getTime() - new Date(b.fulfillment_updated_at).getTime())
                    .map((order) => {
                      const contact = order.contact_id ? contactMap.get(order.contact_id) : null;
                      const age = ageMinutes(order.fulfillment_updated_at);
                      return (
                        <Card key={order.id} className={age >= 20 ? 'border-amber-500/50' : undefined}>
                          <CardContent className="space-y-3 p-4">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-lg font-bold text-foreground">Pedido #{order.order_code}</p>
                                <p className="text-xs text-muted-foreground">{contact?.name ?? 'Cliente'}</p>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-1">
                                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${order.fulfillment_type === 'delivery' ? 'bg-blue-500/10 text-blue-400' : 'bg-violet-500/10 text-violet-400'}`}>
                                  {order.fulfillment_type === 'delivery' ? <Truck className="h-3 w-3" /> : <PackageCheck className="h-3 w-3" />}
                                  {order.fulfillment_type === 'delivery' ? 'Entrega' : 'Retirada'}
                                </span>
                                <span className={`text-[11px] ${age >= 20 ? 'font-semibold text-amber-400' : 'text-muted-foreground'}`}>
                                  <Clock3 className="mr-1 inline h-3 w-3" />{ageLabel(age)}
                                </span>
                              </div>
                            </div>
                            <ul className="space-y-1 text-base text-foreground">
                              {(itemMap.get(order.id) ?? []).map((item, index) => (
                                <li key={index} className="font-medium">{item.quantity}x {item.name_snapshot}</li>
                              ))}
                            </ul>
                            {column.next && (
                              <Button size="lg" className="w-full text-base" disabled={saving === order.id} onClick={() => void advance(order.id, column.next!)}>
                                {saving === order.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                {column.action}
                              </Button>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
