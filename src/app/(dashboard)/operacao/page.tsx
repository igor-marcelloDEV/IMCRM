'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ChefHat, Copy, ExternalLink, PackageCheck, Store, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';

interface AccountInfo { id: string; name: string | null; store_slug: string | null }

export default function OperacaoPage() {
  const [account, setAccount] = useState<AccountInfo | null>(null);

  useEffect(() => {
    fetch('/api/account', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => setAccount(data?.account ?? null))
      .catch(() => {});
  }, []);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const storeUrl = account ? `${origin}/loja/${account.store_slug || account.id}` : null;
  const driverSignupUrl = account ? `${origin}/entregadores/cadastrar/${account.id}` : null;

  const copy = (url: string | null, label: string) => {
    if (!url) return;
    void navigator.clipboard.writeText(url).then(() => toast.success(`Link ${label} copiado!`));
  };

  const externalCards: Array<{ title: string; description: string; icon: typeof Store; color: string; href: string | null; copyLabel: string }> = [
    {
      title: 'Loja pública',
      description: 'A vitrine que seus clientes usam pra comprar direto pelo link.',
      icon: Store,
      color: 'text-cyan-400 bg-cyan-500/10',
      href: storeUrl,
      copyLabel: 'da loja',
    },
    {
      title: 'Sou entregador',
      description: 'Link de cadastro pra novos entregadores se registrarem na sua loja.',
      icon: Truck,
      color: 'text-blue-400 bg-blue-500/10',
      href: driverSignupUrl,
      copyLabel: 'de cadastro',
    },
  ];

  const internalCards: Array<{ title: string; description: string; icon: typeof ChefHat; color: string; href: string }> = [
    {
      title: 'Painel da cozinha',
      description: 'Pedidos pagos esperando preparo — inicie e marque como pronto.',
      icon: ChefHat,
      color: 'text-amber-400 bg-amber-500/10',
      href: '/kitchen',
    },
    {
      title: 'Prontos — entrega e retirada',
      description: 'Confirme retiradas no balcão e despache entregas prontas.',
      icon: PackageCheck,
      color: 'text-violet-400 bg-violet-500/10',
      href: '/ready',
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Central de operação</h1>
        <p className="mt-1 text-sm text-muted-foreground">Os atalhos do dia a dia — loja, entregadores e os painéis da equipe.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {externalCards.map((card) => {
          const Icon = card.icon;
          const disabled = !card.href;
          return (
            <Card key={card.title} className={disabled ? 'opacity-60' : undefined}>
              <CardContent className="flex h-full flex-col gap-3 p-5">
                <div className={`inline-flex w-fit rounded-lg p-2.5 ${card.color}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-foreground">{card.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{card.description}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="flex-1" disabled={disabled} onClick={() => card.href && window.open(card.href, '_blank', 'noopener')}>
                    Abrir <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" disabled={disabled} onClick={() => copy(card.href, card.copyLabel)}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {internalCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.title}>
              <CardContent className="flex h-full flex-col gap-3 p-5">
                <div className={`inline-flex w-fit rounded-lg p-2.5 ${card.color}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-foreground">{card.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{card.description}</p>
                </div>
                {/* Anchor styled with `buttonVariants` rather than <Button asChild> —
                    the IMCRM Button is the Base UI ButtonPrimitive, no Radix-style
                    asChild slot (see invite-member-dialog.tsx for the same pattern). */}
                <Link href={card.href} className={buttonVariants({ size: 'sm', className: 'w-full' })}>
                  Abrir painel <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
