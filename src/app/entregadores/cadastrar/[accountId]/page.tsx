'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Bike, Car, CheckCircle2, Loader2, PersonStanding, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const VEHICLES = [
  { value: 'motorcycle', label: 'Moto', icon: Bike },
  { value: 'car', label: 'Carro', icon: Car },
  { value: 'bicycle', label: 'Bicicleta', icon: PersonStanding },
] as const;

export default function DriverApplyPage() {
  const params = useParams<{ accountId: string }>();
  const accountId = params?.accountId;

  const [storeName, setStoreName] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    vehicle_type: 'motorcycle' as (typeof VEHICLES)[number]['value'],
    vehicle_plate: '',
    document_number: '',
    pix_key: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    fetch(`/api/public/store/${accountId}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setStoreName(data?.account?.name ?? null))
      .catch(() => {});
  }, [accountId]);

  const ready = form.name.trim().length > 1 && /^\S+@\S+\.\S+$/.test(form.email) && form.phone.replace(/\D/g, '').length >= 10;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || !accountId) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/driver/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, ...form }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'Não foi possível enviar sua candidatura.');
        return;
      }
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#070b12] via-[#0b1220] to-[#0f1b2e] p-4">
        <div className="w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-[#101722] p-8 text-center text-white shadow-2xl">
          <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-400" />
          <h1 className="text-xl font-bold">Candidatura enviada!</h1>
          <p className="text-sm text-white/60">
            {storeName ? `A equipe da ${storeName}` : 'A loja'} vai analisar seus dados. Assim que aprovado, você recebe um link no e-mail informado para criar sua senha e começar a receber corridas.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#070b12] via-[#0b1220] to-[#0f1b2e] p-4">
      <form onSubmit={submit} className="w-full max-w-md space-y-5 rounded-2xl border border-white/10 bg-[#101722] p-6 text-white shadow-2xl sm:p-8">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-cyan-500 shadow-lg shadow-blue-900/40">
          <Truck className="h-7 w-7" />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight">Seja um entregador parceiro</h1>
          <p className="mt-1 text-sm text-white/55">
            {storeName ? `Cadastre-se para fazer entregas para ${storeName}.` : 'Cadastre-se para começar a fazer entregas.'} Pegue corridas quando quiser, direto pelo celular.
          </p>
        </div>

        <div className="space-y-3">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nome completo" required className="h-12 bg-white text-slate-900" />
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Seu e-mail" required className="h-12 bg-white text-slate-900" />
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="WhatsApp com DDD" inputMode="tel" required className="h-12 bg-white text-slate-900" />

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Veículo</p>
            <div className="grid grid-cols-3 gap-2">
              {VEHICLES.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setForm({ ...form, vehicle_type: value })}
                  className={`flex flex-col items-center gap-1 rounded-xl border p-3 text-xs font-semibold ${form.vehicle_type === value ? 'border-blue-500 bg-blue-500/15 text-blue-300' : 'border-white/10 text-white/60'}`}
                >
                  <Icon className="h-5 w-5" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {form.vehicle_type !== 'bicycle' && (
            <Input value={form.vehicle_plate} onChange={(e) => setForm({ ...form, vehicle_plate: e.target.value.toUpperCase() })} placeholder="Placa do veículo" className="h-12 bg-white text-slate-900" />
          )}
          <Input value={form.document_number} onChange={(e) => setForm({ ...form, document_number: e.target.value })} placeholder="CPF" inputMode="numeric" className="h-12 bg-white text-slate-900" />
          <Input value={form.pix_key} onChange={(e) => setForm({ ...form, pix_key: e.target.value })} placeholder="Chave PIX para receber os repasses" className="h-12 bg-white text-slate-900" />
        </div>

        <Button className="h-12 w-full bg-blue-600 text-base font-bold" disabled={!ready || submitting}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Enviar candidatura'}
        </Button>
        <p className="text-center text-[11px] text-white/40">Já tem cadastro? <a href="/entregadores/login" className="text-blue-400 underline">Fazer login</a></p>
      </form>
    </main>
  );
}
