'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, MessageCircle, Plus, Trash2, Truck, UserCheck, UserX, Wallet, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { formatCurrency } from '@/lib/currency';
import type { DeliveryDriver, DeliveryPayout, DeliveryTimeSlot } from '@/types';

interface DriverOrder {
  id: string;
  order_code: string;
  assigned_driver_id: string | null;
}
interface DriverApplication {
  id: string;
  name: string;
  email: string;
  phone: string;
  vehicle_type: string;
  document_number: string | null;
  pix_key: string | null;
}
interface PayoutRow extends DeliveryPayout {
  driver: { name: string } | null;
  order: { order_code: string } | null;
}

export default function DriversPage() {
  const [data, setData] = useState<{ drivers: DeliveryDriver[]; orders: DriverOrder[] }>({ drivers: [], orders: [] });
  const [applications, setApplications] = useState<DriverApplication[]>([]);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [slots, setSlots] = useState<DeliveryTimeSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: '', email: '', phone: '', vehicle_type: 'motorcycle', vehicle_plate: '' });
  const [invite, setInvite] = useState('');
  const [storeSlug, setStoreSlug] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [botEnabled, setBotEnabled] = useState(false);
  const [messageTemplate, setMessageTemplate] = useState('');
  const [newSlot, setNewSlot] = useState({ label: '', start_time: '' });

  const load = useCallback(async () => {
    setLoading(true);
    const [driversRes, appsRes, payoutsRes, slotsRes, accountRes] = await Promise.all([
      fetch('/api/drivers'),
      fetch('/api/drivers/applications'),
      fetch('/api/drivers/payouts'),
      fetch('/api/drivers/time-slots'),
      fetch('/api/account'),
    ]);
    if (driversRes.ok) setData(await driversRes.json());
    if (appsRes.ok) setApplications((await appsRes.json()).applications ?? []);
    if (payoutsRes.ok) setPayouts((await payoutsRes.json()).payouts ?? []);
    if (slotsRes.ok) setSlots((await slotsRes.json()).time_slots ?? []);
    if (accountRes.ok) {
      const { account } = await accountRes.json();
      setStoreSlug(account?.store_slug ?? null);
      setAccountId(account?.id ?? null);
      setBotEnabled(!!account?.driver_notify_auto_enabled);
      setMessageTemplate(account?.driver_message_template ?? '');
    }
    setLoading(false);
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function create() {
    const r = await fetch('/api/drivers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    const d = await r.json();
    if (!r.ok) return toast.error(d.error);
    setInvite(d.invite_url);
    toast.success('Entregador cadastrado.');
    void load();
  }

  async function assign(order_id: string, driver_id: string) {
    if (!driver_id) return;
    const r = await fetch('/api/drivers/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id, driver_id }) });
    const d = await r.json();
    if (!r.ok) return toast.error(d.error);
    toast.success(`Entrega atribuída. Código do cliente: ${d.confirmation_code}`);
    await navigator.clipboard.writeText(d.confirmation_code);
    void load();
  }

  async function decideApplication(driverId: string, action: 'approve' | 'reject') {
    const r = await fetch('/api/drivers/applications', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driver_id: driverId, action }) });
    const d = await r.json();
    if (!r.ok) return toast.error(d.error);
    if (action === 'approve') {
      setInvite(d.invite_url);
      toast.success('Candidatura aprovada — link de convite gerado.');
    } else {
      toast.success('Candidatura recusada.');
    }
    void load();
  }

  async function sendMessage(driver: DeliveryDriver) {
    const text = window.prompt('Mensagem para o entregador:', messageTemplate || 'Olá! Temos uma nova entrega disponível.');
    if (!text) return;
    const r = await fetch(`/api/drivers/${driver.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast.error(d.error ?? 'Não foi possível enviar a mensagem.');
    toast.success(`Mensagem enviada para ${driver.name}.`);
  }

  async function saveBotSettings() {
    const r = await fetch('/api/account', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driver_notify_auto_enabled: botEnabled, driver_message_template: messageTemplate }) });
    if (!r.ok) return toast.error('Não foi possível salvar as configurações.');
    toast.success('Configurações salvas.');
  }

  async function addSlot() {
    if (!newSlot.label.trim() || !newSlot.start_time) return;
    const r = await fetch('/api/drivers/time-slots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newSlot) });
    const d = await r.json();
    if (!r.ok) return toast.error(d.error);
    setNewSlot({ label: '', start_time: '' });
    void load();
  }

  async function removeSlot(id: string) {
    await fetch(`/api/drivers/time-slots?id=${id}`, { method: 'DELETE' });
    void load();
  }

  async function markPaid(id: string) {
    const r = await fetch('/api/drivers/payouts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    if (!r.ok) return toast.error('Não foi possível marcar como pago.');
    void load();
  }

  const applyUrl = accountId ? `${typeof window !== 'undefined' ? window.location.origin : ''}/entregadores/cadastrar/${storeSlug || accountId}` : '';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Entregadores</h1>
        <p className="text-sm text-muted-foreground">Cadastre a equipe de entrega, revise candidaturas, atribua corridas e acompanhe repasses.</p>
      </div>

      {applyUrl && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div>
              <p className="text-sm font-medium">Link de cadastro para entregadores</p>
              <p className="break-all text-xs text-muted-foreground">{applyUrl}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(applyUrl); toast.success('Link copiado.'); }}>
              <Copy className="h-4 w-4" />Copiar link
            </Button>
          </CardContent>
        </Card>
      )}

      {applications.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Candidaturas pendentes ({applications.length})</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {applications.map((app) => (
              <div key={app.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <b className="block text-sm">{app.name}</b>
                  <span className="text-xs text-muted-foreground">{app.phone} · {app.email} · {app.vehicle_type === 'motorcycle' ? 'Moto' : app.vehicle_type === 'car' ? 'Carro' : 'Bicicleta'}</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => decideApplication(app.id, 'approve')}><UserCheck className="h-4 w-4" />Aprovar</Button>
                  <Button size="sm" variant="outline" onClick={() => decideApplication(app.id, 'reject')}><UserX className="h-4 w-4" />Recusar</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Novo entregador</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Input placeholder="Nome completo" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input placeholder="E-mail de acesso" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Input placeholder="Telefone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <div className="grid grid-cols-2 gap-3">
              <select className="h-9 rounded-lg border bg-background px-3 text-sm" value={form.vehicle_type} onChange={(e) => setForm({ ...form, vehicle_type: e.target.value })}>
                <option value="motorcycle">Moto</option>
                <option value="car">Carro</option>
                <option value="bicycle">Bicicleta</option>
                <option value="other">Outro</option>
              </select>
              <Input placeholder="Placa" value={form.vehicle_plate} onChange={(e) => setForm({ ...form, vehicle_plate: e.target.value })} />
            </div>
            <Button onClick={create}><Plus className="h-4 w-4" />Cadastrar e gerar convite</Button>
            {invite && (
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Envie este link ao entregador:</p>
                <p className="mt-1 break-all text-sm">{invite}</p>
                <Button className="mt-2" size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(invite)}><Copy className="h-4 w-4" />Copiar link</Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Equipe cadastrada</CardTitle></CardHeader>
          <CardContent>
            {loading ? <Loader2 className="animate-spin" /> : (
              <div className="space-y-2">
                {data.drivers.map((d) => (
                  <div key={d.id} className="flex items-center gap-3 rounded-lg border p-3">
                    <Truck className="text-primary" />
                    <div className="flex-1">
                      <b className="block text-sm">{d.name}</b>
                      <span className="text-xs text-muted-foreground">{d.phone} · {d.status === 'active' ? 'Ativo' : 'Convite pendente'}</span>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => sendMessage(d)}><MessageCircle className="h-4 w-4" />Mensagem</Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Zap className="h-4 w-4" />Notificação automática de novas corridas</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-3">
            <Switch checked={botEnabled} onCheckedChange={setBotEnabled} />
            <span className="text-sm">Avisar automaticamente os entregadores disponíveis por WhatsApp quando um pedido ficar pronto para entrega</span>
          </label>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Mensagem enviada (use {'{{pedido}}'}, {'{{endereco}}'} e {'{{loja}}'})</label>
            <Input value={messageTemplate} onChange={(e) => setMessageTemplate(e.target.value)} placeholder="Nova entrega disponível: pedido {{pedido}}, entrega em {{endereco}}." />
          </div>
          <Button size="sm" onClick={saveBotSettings}>Salvar configurações</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Horários de retirada na loja</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {slots.map((slot) => (
              <span key={slot.id} className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs">
                {slot.label} ({slot.start_time.slice(0, 5)})
                <button type="button" onClick={() => removeSlot(slot.id)} aria-label="Remover horário"><Trash2 className="h-3 w-3 text-muted-foreground hover:text-red-400" /></button>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Input placeholder="Rótulo (ex: 11h às 11h30)" value={newSlot.label} onChange={(e) => setNewSlot({ ...newSlot, label: e.target.value })} className="max-w-56" />
            <Input type="time" value={newSlot.start_time} onChange={(e) => setNewSlot({ ...newSlot, start_time: e.target.value })} className="max-w-32" />
            <Button size="sm" variant="outline" onClick={addSlot}><Plus className="h-4 w-4" />Adicionar</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Pedidos prontos para atribuição</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.orders.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum pedido pronto aguardando entregador.</p> : data.orders.map((o) => (
            <div key={o.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <b>Pedido #{o.order_code}</b>
              <select className="h-9 rounded-lg border bg-background px-3 text-sm" value={o.assigned_driver_id || ''} onChange={(e) => void assign(o.id, e.target.value)}>
                <option value="">Selecionar entregador</option>
                {data.drivers.filter((d) => d.status === 'active').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Wallet className="h-4 w-4" />Repasses aos entregadores</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {payouts.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum repasse registrado ainda.</p> : payouts.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <b className="block text-sm">{p.driver?.name ?? 'Entregador'} · Pedido #{p.order?.order_code}</b>
                <span className="text-xs text-muted-foreground">{formatCurrency(p.amount_cents / 100, 'BRL')} · {p.status === 'paid' ? `Pago em ${new Date(p.paid_at!).toLocaleDateString('pt-BR')}` : 'Pendente'}</span>
              </div>
              {p.status === 'pending' && <Button size="sm" variant="outline" onClick={() => markPaid(p.id)}>Marcar como pago</Button>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
