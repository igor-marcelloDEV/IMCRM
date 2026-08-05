'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChefHat, Clock3, Eye, EyeOff, Lightbulb, Loader2, PackageCheck, RefreshCw, Truck, WalletCards } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/currency';

type FulfillmentStatus = 'awaiting_payment' | 'confirmed' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered';
interface Row { id: string; order_code: string; contact_id: string | null; fulfillment_status: FulfillmentStatus; fulfillment_updated_at: string; total_cents: number; currency: string; created_at: string }
interface Item { order_id: string; name_snapshot: string; quantity: number }
interface Contact { id: string; name: string | null; phone: string }
const HIDE_VALUES_KEY = 'imcrm.fulfillment.hideValues';
const columns: Array<{ status: FulfillmentStatus; label: string; icon: typeof CheckCircle2; next?: FulfillmentStatus; action?: string; empty: string }> = [
  { status: 'awaiting_payment', label: 'Aguardando pagamento', icon: WalletCards, empty: 'Nenhuma cobrança pendente.' },
  { status: 'confirmed', label: 'Confirmados', icon: CheckCircle2, next: 'preparing', action: 'Iniciar preparo', empty: 'Nenhum pedido aguardando preparo.' },
  { status: 'preparing', label: 'Em preparo', icon: ChefHat, next: 'ready', action: 'Marcar como pronto', empty: 'A produção está livre.' },
  { status: 'ready', label: 'Prontos', icon: PackageCheck, next: 'out_for_delivery', action: 'Saiu para entrega', empty: 'Nenhum pedido esperando despacho.' },
  { status: 'out_for_delivery', label: 'Em entrega', icon: Truck, next: 'delivered', action: 'Confirmar entrega', empty: 'Nenhuma entrega em rota.' },
  { status: 'delivered', label: 'Entregues', icon: CheckCircle2, empty: 'As entregas concluídas aparecerão aqui.' },
];

function ageHours(date: string) { return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 3_600_000)); }
function ageLabel(hours: number) { return hours < 1 ? 'Agora' : hours < 24 ? `Há ${hours}h` : `Há ${Math.floor(hours / 24)}d`; }

export default function FulfillmentPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [hideValues, setHideValues] = useState(false);
  useEffect(() => setHideValues(localStorage.getItem(HIDE_VALUES_KEY) === '1'), []);
  const toggleValues = () => setHideValues((current) => { const next = !current; localStorage.setItem(HIDE_VALUES_KEY, next ? '1' : '0'); return next; });
  const load = useCallback(async () => {
    const response = await fetch('/api/fulfillment', { cache: 'no-store' });
    if (!response.ok) { toast.error('Não foi possível carregar as entregas.'); return; }
    const data = await response.json(); setRows(data.orders); setItems(data.items); setContacts(data.contacts);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const contactMap = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact])), [contacts]);
  const itemMap = useMemo(() => { const map = new Map<string, Item[]>(); items.forEach((item) => map.set(item.order_id, [...(map.get(item.order_id) ?? []), item])); return map; }, [items]);
  const summary = useMemo(() => {
    const all = rows ?? []; const active = all.filter((row) => !['awaiting_payment', 'delivered'].includes(row.fulfillment_status));
    const delayed = active.filter((row) => ageHours(row.fulfillment_updated_at) >= 24);
    const today = new Date().toDateString();
    return { pending: all.filter((row) => row.fulfillment_status === 'awaiting_payment').length, active: active.length, delayed: delayed.length, deliveredToday: all.filter((row) => row.fulfillment_status === 'delivered' && new Date(row.fulfillment_updated_at).toDateString() === today).length, activeValue: active.reduce((sum, row) => sum + row.total_cents, 0) };
  }, [rows]);
  const insights = useMemo(() => {
    const result: string[] = [];
    if (summary.pending) result.push(`${summary.pending} pedido(s) aguardam pagamento. Priorize uma mensagem de recuperação com o link da cobrança.`);
    if (summary.delayed) result.push(`${summary.delayed} pedido(s) estão há mais de 24 horas na mesma etapa. Defina responsável e prazo.`);
    const ready = (rows ?? []).filter((row) => row.fulfillment_status === 'ready').length;
    if (ready) result.push(`${ready} pedido(s) pronto(s) podem ser agrupados na próxima rota para reduzir tempo e custo de entrega.`);
    if (!result.length) result.push('Operação em dia. O próximo aprimoramento é medir o tempo médio entre preparo e entrega.');
    return result;
  }, [rows, summary]);
  const summaryCards = [
    { label: 'Aguardando pagamento', value: summary.pending, icon: WalletCards },
    { label: 'Em operação', value: summary.active, icon: ChefHat },
    { label: 'Atrasados +24h', value: summary.delayed, icon: AlertTriangle },
    { label: 'Entregues hoje', value: summary.deliveredToday, icon: CheckCircle2 },
  ];
  const advance = async (orderId: string, status: FulfillmentStatus) => {
    setSaving(orderId);
    const response = await fetch('/api/fulfillment', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: orderId, fulfillment_status: status }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) toast.error(data.error ?? 'Não foi possível atualizar o andamento.');
    else setRows((current) => current?.map((row) => row.id === orderId ? { ...row, fulfillment_status: status, fulfillment_updated_at: new Date().toISOString() } : row) ?? null);
    setSaving(null);
  };

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-bold text-foreground">Operação de pedidos</h1><p className="mt-1 text-sm text-muted-foreground">Do pagamento confirmado até a entrega, com alertas para o que precisa de atenção.</p></div><div className="flex gap-2"><Button variant="outline" onClick={toggleValues}>{hideValues ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}{hideValues ? 'Mostrar valores' : 'Ocultar valores'}</Button><Button variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />Atualizar</Button></div></div>
    {rows === null ? <div className="h-48 animate-pulse rounded-lg bg-muted" /> : <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {summaryCards.map(({ label, value, icon: Icon }) => <Card key={label}><CardContent className="flex items-center gap-3 p-4"><div className="rounded-lg bg-primary/10 p-2 text-primary"><Icon className="h-5 w-5" /></div><div><p className="text-xl font-bold text-foreground">{value}</p><p className="text-xs text-muted-foreground">{label}</p></div></CardContent></Card>)}
        <Card><CardContent className="p-4"><p className={`text-xl font-bold text-foreground ${hideValues ? 'blur-sm select-none' : ''}`}>{formatCurrency(summary.activeValue / 100, 'BRL')}</p><p className="text-xs text-muted-foreground">Valor em operação</p></CardContent></Card>
      </div>
      <Card className="border-blue-500/20 bg-blue-500/5"><CardContent className="p-4"><div className="flex gap-3"><Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" /><div><p className="text-sm font-semibold text-foreground">Insights para melhorar agora</p><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{insights.map((insight) => <li key={insight}>• {insight}</li>)}</ul></div></div></CardContent></Card>
      <div className="grid gap-4 xl:grid-cols-3 2xl:grid-cols-6">
        {columns.map((column) => { const Icon = column.icon; const matches = rows.filter((row) => row.fulfillment_status === column.status); const columnValue = matches.reduce((sum, row) => sum + row.total_cents, 0); const oldest = Math.max(0, ...matches.map((row) => ageHours(row.fulfillment_updated_at))); return <section key={column.status} className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/20 p-3">
          <div><div className="flex items-center gap-2 text-sm font-semibold text-foreground"><Icon className="h-4 w-4 text-primary" />{column.label}<span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{matches.length}</span></div><div className="mt-2 flex justify-between text-[11px] text-muted-foreground"><span className={hideValues ? 'blur-sm select-none' : ''}>{formatCurrency(columnValue / 100, 'BRL')}</span>{matches.length > 0 && <span>Mais antigo: {ageLabel(oldest)}</span>}</div></div>
          {matches.length === 0 && <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">{column.empty}</div>}
          {matches.map((order) => { const contact = order.contact_id ? contactMap.get(order.contact_id) : null; const age = ageHours(order.fulfillment_updated_at); return <Card key={order.id} onClick={() => router.push(`/orders?order=${order.id}`)} className={`cursor-pointer transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md ${age >= 24 && !['awaiting_payment', 'delivered'].includes(order.fulfillment_status) ? 'border-amber-500/40' : ''}`}><CardContent className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-2"><div><p className="font-semibold text-foreground">Pedido #{order.order_code}</p><p className="text-xs text-muted-foreground">{contact?.name ?? 'Cliente'} · {contact?.phone ?? ''}</p></div><span className={`shrink-0 text-[10px] ${age >= 24 ? 'text-amber-400' : 'text-muted-foreground'}`}><Clock3 className="mr-1 inline h-3 w-3" />{ageLabel(age)}</span></div>
            <ul className="space-y-1 text-xs text-foreground">{(itemMap.get(order.id) ?? []).map((item, index) => <li key={index}>{item.quantity}x {item.name_snapshot}</li>)}</ul>
            <p className={`border-t border-border pt-2 text-sm font-semibold ${hideValues ? 'blur-sm select-none' : ''}`}>{formatCurrency(order.total_cents / 100, order.currency)}</p>
            {column.next && <Button size="sm" className="w-full" disabled={saving === order.id} onClick={(event) => { event.stopPropagation(); void advance(order.id, column.next!); }}>{saving === order.id && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}{column.action}</Button>}
          </CardContent></Card>; })}
        </section>; })}
      </div>
    </>}
  </div>;
}
