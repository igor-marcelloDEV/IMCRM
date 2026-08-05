'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock, LogOut, MapPin, Navigation, Package, Truck, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency } from '@/lib/currency';

interface MyDelivery {
  id: string;
  order_code: string;
  fulfillment_status: string;
  contact_id: string | null;
}
interface Contact {
  id: string;
  name: string | null;
  phone: string | null;
  delivery_address: string | null;
}
interface OpenJob {
  id: string;
  order_code: string;
  total_cents: number;
  currency: string;
  delivery_fee_cents: number;
  delivery_address_line: string | null;
  delivery_number: string | null;
  delivery_neighborhood: string | null;
  delivery_city: string | null;
  distance_km: number | null;
}
interface TimeSlot {
  id: string;
  label: string;
  start_time: string;
}

export default function DriverPortal() {
  const [tab, setTab] = useState<'mine' | 'open'>('mine');
  const [data, setData] = useState<{ driver?: { name?: string; is_available?: boolean }; orders: MyDelivery[]; contacts: Contact[] }>({ orders: [], contacts: [] });
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [openJobs, setOpenJobs] = useState<OpenJob[]>([]);
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [chosenSlot, setChosenSlot] = useState<Record<string, string>>({});
  const [claiming, setClaiming] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/driver/deliveries', { cache: 'no-store' });
    if (r.status === 401) return void (location.href = '/entregadores/login');
    setData(await r.json());
  }, []);

  const loadOpenJobs = useCallback(async () => {
    const r = await fetch('/api/driver/open-jobs', { cache: 'no-store' });
    if (r.status === 401) return void (location.href = '/entregadores/login');
    const d = await r.json();
    setOpenJobs(d.jobs ?? []);
    setSlots(d.time_slots ?? []);
  }, []);

  useEffect(() => {
    void load();
    void loadOpenJobs();
    const interval = setInterval(loadOpenJobs, 20000);
    return () => clearInterval(interval);
  }, [load, loadOpenJobs]);

  async function action(order_id: string, action: string) {
    const r = await fetch('/api/driver/deliveries', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id, action, code: codes[order_id] }) });
    const d = await r.json();
    if (!r.ok) return toast.error(d.error);
    toast.success(action === 'start' ? 'Rota iniciada.' : 'Entrega confirmada!');
    void load();
  }

  async function toggleAvailability() {
    const next = !data.driver?.is_available;
    const r = await fetch('/api/driver/deliveries', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'availability', is_available: next }) });
    if (!r.ok) return toast.error('Não foi possível atualizar sua disponibilidade.');
    setData((prev) => ({ ...prev, driver: { ...prev.driver, is_available: next } }));
  }

  async function claim(orderId: string) {
    setClaiming(orderId);
    try {
      const r = await fetch('/api/driver/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: orderId, time_slot_id: chosenSlot[orderId] || null }) });
      const d = await r.json();
      if (!r.ok) return toast.error(d.error);
      toast.success(`Corrida aceita! Código de confirmação: ${d.confirmation_code}`);
      setTab('mine');
      void load();
      void loadOpenJobs();
    } finally {
      setClaiming(null);
    }
  }

  const contacts = new Map(data.contacts?.map((c) => [c.id, c]));

  return (
    <main className="min-h-screen bg-[#f3f5f7] text-slate-900">
      <header className="sticky top-0 z-10 bg-slate-950 px-4 py-4 text-white shadow">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600"><Truck /></span>
          <div className="flex-1">
            <b className="block">Olá, {data.driver?.name || 'entregador'}</b>
            <span className="text-xs text-white/55">{data.orders?.length || 0} entrega(s) na rota</span>
          </div>
          <button
            type="button"
            onClick={toggleAvailability}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${data.driver?.is_available ? 'bg-emerald-500 text-white' : 'bg-white/10 text-white/70'}`}
          >
            {data.driver?.is_available ? 'Disponível' : 'Indisponível'}
          </button>
          <Button variant="ghost" size="icon" onClick={async () => { await createClient().auth.signOut(); location.href = '/entregadores/login'; }}><LogOut /></Button>
        </div>
        <div className="mx-auto mt-3 flex max-w-2xl gap-1 rounded-xl bg-white/10 p-1">
          <button type="button" onClick={() => setTab('mine')} className={`flex-1 rounded-lg py-2 text-sm font-semibold ${tab === 'mine' ? 'bg-white text-slate-900' : 'text-white/70'}`}>Minhas entregas</button>
          <button type="button" onClick={() => setTab('open')} className={`relative flex-1 rounded-lg py-2 text-sm font-semibold ${tab === 'open' ? 'bg-white text-slate-900' : 'text-white/70'}`}>
            Corridas disponíveis
            {openJobs.length > 0 && <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-slate-900">{openJobs.length}</span>}
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-2xl space-y-4 p-4">
        {tab === 'mine' ? (
          data.orders?.length === 0 ? (
            <div className="rounded-2xl bg-white p-10 text-center shadow-sm">
              <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
              <h2 className="mt-3 font-bold">Nenhuma entrega pendente</h2>
              <p className="text-sm text-slate-500">Aceite uma corrida disponível para começar.</p>
            </div>
          ) : (
            data.orders.map((o) => {
              const c = o.contact_id ? contacts.get(o.contact_id) : undefined;
              return (
                <article key={o.id} className="overflow-hidden rounded-2xl bg-white shadow-sm">
                  <div className="flex items-center gap-3 border-b p-4">
                    <Package className="text-blue-600" />
                    <div className="flex-1">
                      <b>Pedido #{o.order_code}</b>
                      <p className="text-xs text-slate-500">{c?.name || 'Cliente'} · {c?.phone}</p>
                    </div>
                    <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">{o.fulfillment_status === 'ready' ? 'Aguardando retirada' : 'Em rota'}</span>
                  </div>
                  <div className="space-y-3 p-4">
                    <div className="flex gap-2 text-sm">
                      <MapPin className="h-5 w-5 shrink-0 text-slate-400" />
                      <span>{c?.delivery_address || 'Endereço não informado'}</span>
                    </div>
                    {c?.delivery_address && (
                      <a target="_blank" rel="noopener" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.delivery_address)}`} className="flex h-11 items-center justify-center gap-2 rounded-xl border font-semibold text-blue-700">
                        <Navigation className="h-4 w-4" />Abrir rota no mapa
                      </a>
                    )}
                    {o.fulfillment_status === 'ready' ? (
                      <Button className="h-12 w-full bg-blue-600 text-base font-bold" onClick={() => action(o.id, 'start')}>Iniciar entrega</Button>
                    ) : (
                      <div className="space-y-2">
                        <label className="text-sm font-semibold">Código informado pelo cliente</label>
                        <div className="flex gap-2">
                          <Input inputMode="numeric" maxLength={4} value={codes[o.id] || ''} onChange={(e) => setCodes({ ...codes, [o.id]: e.target.value.replace(/\D/g, '') })} placeholder="0000" className="h-12 text-center text-xl tracking-[.35em]" />
                          <Button className="h-12 bg-emerald-600 font-bold" disabled={(codes[o.id] || '').length !== 4} onClick={() => action(o.id, 'complete')}>Confirmar</Button>
                        </div>
                      </div>
                    )}
                  </div>
                </article>
              );
            })
          )
        ) : openJobs.length === 0 ? (
          <div className="rounded-2xl bg-white p-10 text-center shadow-sm">
            <Zap className="mx-auto h-12 w-12 text-slate-300" />
            <h2 className="mt-3 font-bold">Nenhuma corrida disponível agora</h2>
            <p className="text-sm text-slate-500">Fique disponível para ser avisado quando surgir uma nova.</p>
          </div>
        ) : (
          openJobs.map((job) => {
            const address = [job.delivery_address_line && `${job.delivery_address_line}, ${job.delivery_number ?? ''}`, job.delivery_neighborhood, job.delivery_city].filter(Boolean).join(' · ');
            return (
              <article key={job.id} className="overflow-hidden rounded-2xl bg-white shadow-sm">
                <div className="flex items-center gap-3 border-b p-4">
                  <Package className="text-emerald-600" />
                  <div className="flex-1">
                    <b>Pedido #{job.order_code}</b>
                    <p className="text-xs text-slate-500">{formatCurrency(job.total_cents / 100, job.currency)}{job.delivery_fee_cents > 0 && ` · taxa ${formatCurrency(job.delivery_fee_cents / 100, job.currency)}`}</p>
                  </div>
                  {job.distance_km != null && <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">~{job.distance_km} km</span>}
                </div>
                <div className="space-y-3 p-4">
                  <div className="flex gap-2 text-sm">
                    <MapPin className="h-5 w-5 shrink-0 text-slate-400" />
                    <span>{address || 'Endereço não informado'}</span>
                  </div>
                  {slots.length > 0 && (
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-sm font-semibold"><Clock className="h-3.5 w-3.5" />Horário de retirada na loja</label>
                      <select value={chosenSlot[job.id] || ''} onChange={(e) => setChosenSlot({ ...chosenSlot, [job.id]: e.target.value })} className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm">
                        <option value="">Combinar depois</option>
                        {slots.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.start_time.slice(0, 5)})</option>)}
                      </select>
                    </div>
                  )}
                  <Button className="h-12 w-full bg-emerald-600 text-base font-bold" disabled={claiming === job.id} onClick={() => claim(job.id)}>
                    {claiming === job.id ? 'Aceitando…' : 'Aceitar corrida'}
                  </Button>
                </div>
              </article>
            );
          })
        )}
      </div>
    </main>
  );
}
