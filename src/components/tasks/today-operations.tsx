'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDownLeft,
  ArrowUpRight,
  GitBranch,
  MessageSquare,
  Package,
  RefreshCw,
  UserPlus,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';
import { localDayRange } from '@/lib/tasks/dates';
import { cn } from '@/lib/utils';

interface TodayMetrics {
  incoming: number;
  outgoing: number;
  openConversations: number;
  activePipelines: number;
  openDeals: number;
  orders: number;
  contacts: number;
}

const emptyMetrics: TodayMetrics = {
  incoming: 0,
  outgoing: 0,
  openConversations: 0,
  activePipelines: 0,
  openDeals: 0,
  orders: 0,
  contacts: 0,
};

export function TodayOperations() {
  const [metrics, setMetrics] = useState<TodayMetrics>(emptyMetrics);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const db = createClient();
    const { from, to } = localDayRange();

    const [incoming, outgoing, conversations, deals, orders, contacts] =
      await Promise.all([
        db.from('messages').select('id', { count: 'exact', head: true }).eq('sender_type', 'customer').gte('created_at', from).lt('created_at', to),
        db.from('messages').select('id', { count: 'exact', head: true }).in('sender_type', ['agent', 'bot']).gte('created_at', from).lt('created_at', to),
        db.from('conversations').select('id', { count: 'exact', head: true }).eq('status', 'open'),
        db.from('deals').select('pipeline_id').eq('status', 'open'),
        db.from('orders').select('id', { count: 'exact', head: true }).gte('created_at', from).lt('created_at', to),
        db.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', from).lt('created_at', to),
      ]);

    const responses = [incoming, outgoing, conversations, deals, orders, contacts];
    if (responses.some((response) => response.error)) {
      setError(true);
      setLoading(false);
      return;
    }

    const dealRows = (deals.data ?? []) as Array<{ pipeline_id: string | null }>;
    setMetrics({
      incoming: incoming.count ?? 0,
      outgoing: outgoing.count ?? 0,
      openConversations: conversations.count ?? 0,
      activePipelines: new Set(dealRows.map((deal) => deal.pipeline_id).filter(Boolean)).size,
      openDeals: dealRows.length,
      orders: orders.count ?? 0,
      contacts: contacts.count ?? 0,
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const cards = [
    { label: 'Mensagens recebidas hoje', value: metrics.incoming, detail: 'Clientes falaram com você', icon: ArrowDownLeft, href: '/inbox', color: 'text-emerald-500', background: 'bg-emerald-500/10' },
    { label: 'Mensagens enviadas hoje', value: metrics.outgoing, detail: 'Equipe e automações', icon: ArrowUpRight, href: '/inbox', color: 'text-blue-500', background: 'bg-blue-500/10' },
    { label: 'Atendimentos abertos', value: metrics.openConversations, detail: 'Conversas que exigem atenção', icon: MessageSquare, href: '/inbox', color: 'text-violet-500', background: 'bg-violet-500/10' },
    { label: 'Funis ativos', value: metrics.activePipelines, detail: `${metrics.openDeals} negócio(s) em andamento`, icon: GitBranch, href: '/pipelines', color: 'text-amber-500', background: 'bg-amber-500/10' },
    { label: 'Pedidos criados hoje', value: metrics.orders, detail: 'Novas vendas registradas', icon: Package, href: '/orders', color: 'text-cyan-500', background: 'bg-cyan-500/10' },
    { label: 'Novos contatos hoje', value: metrics.contacts, detail: 'Pessoas adicionadas à base', icon: UserPlus, href: '/contacts', color: 'text-pink-500', background: 'bg-pink-500/10' },
  ];

  return (
    <section aria-labelledby="today-operations-title" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="today-operations-title" className="text-sm font-semibold text-foreground">Movimento de hoje</h2>
          <p className="text-xs text-muted-foreground">Acompanhe o que está acontecendo agora na operação.</p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => void load()} disabled={loading} aria-label="Atualizar indicadores de hoje">
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </Button>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">Não foi possível carregar os indicadores. Tente atualizar novamente.</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
          {cards.map((card) => (
            <Link key={card.label} href={card.href} className="group min-w-0 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/30">
              <div className="flex items-start justify-between gap-2">
                <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', card.background, card.color)}><card.icon className="size-4" /></span>
                <ArrowUpRight className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              {loading ? <div className="mt-3 h-7 w-12 animate-pulse rounded bg-muted" /> : <p className="mt-3 text-2xl font-semibold tabular-nums text-foreground">{card.value}</p>}
              <p className="mt-1 text-xs font-medium leading-4 text-foreground">{card.label}</p>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">{card.detail}</p>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
