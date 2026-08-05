'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BarChart3, Boxes, Download, ExternalLink, FileText, History, Info, Loader2, PackagePlus, Paperclip, Upload, X } from 'lucide-react';
import { CatalogManager } from '@/components/settings/catalog-manager';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { CatalogItem } from '@/types';
import { formatCurrency } from '@/lib/currency';
import { deleteAccountMedia, uploadAccountMedia } from '@/lib/storage/upload-media';

const RECEIPTS_BUCKET = 'inventory-receipts';
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

interface StockMovement {
  id: string;
  catalog_item_id: string | null;
  item_name: string;
  quantity_delta: number;
  balance_after: number | null;
  movement_type: 'initial' | 'stock_entry' | 'sale_or_removal' | 'adjustment';
  note: string | null;
  created_at: string;
  receipt_name: string | null;
  receipt_url: string | null;
}

function csvCell(value: unknown) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: unknown[][]) {
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(';')).join('\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function CatalogPage() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [batchOpen, setBatchOpen] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [catalogRes, movementRes] = await Promise.all([
        fetch('/api/catalog', { cache: 'no-store' }),
        fetch('/api/catalog/stock-movements?limit=1000', { cache: 'no-store' }),
      ]);
      const catalogData = await catalogRes.json().catch(() => ({}));
      const movementData = await movementRes.json().catch(() => ({}));
      if (catalogRes.ok) setItems(catalogData.catalog_items ?? []);
      if (movementRes.ok) setMovements(movementData.movements ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const trackedItems = items.filter((item) => item.stock_quantity !== null);
  const totalUnits = trackedItems.reduce((sum, item) => sum + (item.stock_quantity ?? 0), 0);
  const inventoryValue = trackedItems.reduce(
    (sum, item) => sum + (item.stock_quantity ?? 0) * item.price_cents,
    0,
  );
  const lowStock = trackedItems.filter((item) => (item.stock_quantity ?? 0) <= 5).length;
  const entries = movements.filter((movement) => movement.quantity_delta > 0);
  const exits = movements.filter((movement) => movement.quantity_delta < 0);
  const totalEntered = entries.reduce((sum, movement) => sum + movement.quantity_delta, 0);
  const totalExited = Math.abs(exits.reduce((sum, movement) => sum + movement.quantity_delta, 0));

  const selectedAdjustments = useMemo(
    () => Object.entries(quantities)
      .map(([catalog_item_id, raw]) => ({ catalog_item_id, quantity: Number(raw) }))
      .filter((entry) => Number.isInteger(entry.quantity) && entry.quantity > 0),
    [quantities],
  );

  async function addBatch() {
    if (selectedAdjustments.length === 0) {
      toast.error('Informe a quantidade de pelo menos um item.');
      return;
    }
    setSaving(true);
    let uploadedPath: string | null = null;
    try {
      let receipt: { path: string; name: string; mime: string } | null = null;
      if (receiptFile) {
        const uploaded = await uploadAccountMedia(RECEIPTS_BUCKET, receiptFile);
        uploadedPath = uploaded.path;
        receipt = { path: uploaded.path, name: receiptFile.name, mime: receiptFile.type };
      }
      const response = await fetch('/api/catalog/stock-movements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adjustments: selectedAdjustments, note,
          receipt_path: receipt?.path, receipt_name: receipt?.name, receipt_mime_type: receipt?.mime,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? 'Falha ao adicionar estoque.');
      toast.success(`Estoque atualizado em ${selectedAdjustments.length} item(ns).`);
      setBatchOpen(false);
      setQuantities({});
      setNote('');
      setReceiptFile(null);
      await load();
    } catch (error) {
      if (uploadedPath) await deleteAccountMedia(RECEIPTS_BUCKET, uploadedPath).catch(() => undefined);
      toast.error(error instanceof Error ? error.message : 'Falha ao adicionar estoque.');
    } finally {
      setSaving(false);
    }
  }

  function selectReceipt(file: File | null) {
    if (!file) return;
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) return void toast.error('Envie um arquivo PDF, JPG, PNG ou WebP.');
    if (file.size > MAX_RECEIPT_BYTES) return void toast.error('O comprovante deve ter no máximo 10 MB.');
    setReceiptFile(file);
  }

  function exportInventory() {
    downloadCsv('relatorio-estoque.csv', [
      ['Produto', 'Preço', 'Estoque', 'Valor em estoque', 'Ativo'],
      ...items.map((item) => [
        item.name,
        (item.price_cents / 100).toFixed(2),
        item.stock_quantity ?? 'Não controlado',
        item.stock_quantity === null ? '' : ((item.stock_quantity * item.price_cents) / 100).toFixed(2),
        item.is_active ? 'Sim' : 'Não',
      ]),
    ]);
  }

  function exportMovements() {
    downloadCsv('relatorio-movimentacoes.csv', [
      ['Data', 'Produto', 'Tipo', 'Quantidade', 'Saldo', 'Observação', 'Comprovante'],
      ...movements.map((movement) => [
        new Date(movement.created_at).toLocaleString('pt-BR'),
        movement.item_name,
        movement.movement_type,
        movement.quantity_delta,
        movement.balance_after ?? '',
        movement.note ?? '',
        movement.receipt_name ?? '',
      ]),
    ]);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Catálogo e estoque</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Gerencie produtos, entradas, saídas e relatórios em um só lugar.
          </p>
        </div>
        <Button onClick={() => setBatchOpen(true)}>
          <PackagePlus className="h-4 w-4" />
          Adicionar estoque em lote
        </Button>
      </div>

      <Tabs defaultValue="items" onValueChange={() => void load()}>
        <TabsList>
          <TabsTrigger value="items"><Boxes className="h-4 w-4" /> Produtos</TabsTrigger>
          <TabsTrigger value="history"><History className="h-4 w-4" /> Movimentações</TabsTrigger>
          <TabsTrigger value="reports"><BarChart3 className="h-4 w-4" /> Relatórios</TabsTrigger>
        </TabsList>
        <TabsContent value="items" className="space-y-4 pt-4">
          <TabGuide
            title="Produtos, serviços e planos"
            description="Cadastre tudo o que sua empresa vende. O tipo escolhido determina como a loja apresenta a oferta, como o pagamento funciona e qual documento fiscal deverá ser emitido."
            tips={['Produto físico: controle estoque e preencha SKU, NCM, CEST e CFOP.', 'Serviço: venda avulsa com emissão de NFS-e após o pagamento.', 'Assinatura: defina periodicidade, teste grátis, campanha e cobrança recorrente pelo Asaas.']}
          />
          <CatalogManager />
        </TabsContent>
        <TabsContent value="history" className="space-y-4 pt-4">
          <TabGuide
            title="Histórico de movimentações"
            description="Aqui fica a trilha de auditoria do estoque. Cada entrada ou saída informa produto, quantidade movimentada, saldo resultante, observação e comprovante."
            tips={['Use “Adicionar estoque em lote” quando receber mercadorias.', 'Anexe nota, recibo ou comprovante para documentar a entrada.', 'Valores positivos representam entradas; valores negativos representam vendas ou baixas.']}
          />
          <Card>
            <CardHeader><CardTitle>Histórico de movimentações</CardTitle><p className="text-sm text-muted-foreground">Consulte quem entrou ou saiu do estoque e abra os documentos vinculados.</p></CardHeader>
            <CardContent>
              {loading ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : movements.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Nenhuma movimentação registrada.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b text-left text-muted-foreground"><th className="p-2">Data</th><th className="p-2">Produto</th><th className="p-2">Movimento</th><th className="p-2">Saldo</th><th className="p-2">Observação</th><th className="p-2">Comprovante</th></tr></thead>
                    <tbody>{movements.map((movement) => (
                      <tr key={movement.id} className="border-b border-border/60">
                        <td className="whitespace-nowrap p-2 text-muted-foreground">{new Date(movement.created_at).toLocaleString('pt-BR')}</td>
                        <td className="p-2 font-medium">{movement.item_name}</td>
                        <td className={`p-2 font-semibold ${movement.quantity_delta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{movement.quantity_delta > 0 ? '+' : ''}{movement.quantity_delta}</td>
                        <td className="p-2">{movement.balance_after ?? '—'}</td>
                        <td className="p-2 text-muted-foreground">{movement.note ?? '—'}</td>
                        <td className="p-2">{movement.receipt_url ? <a href={movement.receipt_url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-44 items-center gap-1.5 text-primary hover:underline"><FileText className="h-4 w-4 shrink-0" /><span className="truncate">{movement.receipt_name ?? 'Abrir'}</span><ExternalLink className="h-3 w-3 shrink-0" /></a> : <span className="text-muted-foreground">—</span>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="reports" className="space-y-4 pt-4">
          <TabGuide
            title="Indicadores e relatórios"
            description="Acompanhe a posição atual do estoque e exporte os dados para conferência administrativa, contábil ou planejamento de compras."
            tips={['Valor potencial considera preço de venda multiplicado pelo saldo.', 'Estoque baixo destaca produtos com cinco unidades ou menos.', 'Os arquivos CSV podem ser abertos no Excel e incluem observações e comprovantes.']}
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric title="Unidades em estoque" value={String(totalUnits)} />
            <Metric title="Valor potencial" value={formatCurrency(inventoryValue / 100, items[0]?.currency ?? 'BRL')} />
            <Metric title="Entradas registradas" value={String(totalEntered)} />
            <Metric title="Saídas registradas" value={String(totalExited)} detail={`${lowStock} produto(s) com estoque baixo`} />
          </div>
          <Card><CardHeader><CardTitle>Emitir relatórios</CardTitle></CardHeader><CardContent className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={exportInventory}><Download className="h-4 w-4" /> Relatório de estoque</Button>
            <Button variant="outline" onClick={exportMovements}><Download className="h-4 w-4" /> Relatório de movimentações</Button>
          </CardContent></Card>
        </TabsContent>
      </Tabs>

      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader><DialogTitle>Adicionar estoque em lote</DialogTitle><DialogDescription>Informe somente as quantidades que estão entrando agora. O saldo será somado automaticamente.</DialogDescription></DialogHeader>
          <div className="space-y-2">{items.map((item) => (
            <div key={item.id} className="grid grid-cols-[1fr_120px] items-center gap-3 rounded-md border p-3">
              <div><p className="text-sm font-medium">{item.name}</p><p className="text-xs text-muted-foreground">Saldo atual: {item.stock_quantity ?? 0}</p></div>
              <Input value={quantities[item.id] ?? ''} onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: event.target.value }))} inputMode="numeric" min={1} type="number" placeholder="Quantidade" />
            </div>
          ))}</div>
          <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Observação do lote (ex.: Nota fiscal 1234)" maxLength={500} />
          <div className="rounded-lg border border-dashed border-border p-3">
            <p className="mb-2 text-sm font-medium">Comprovante da entrada <span className="font-normal text-muted-foreground">(opcional)</span></p>
            {receiptFile ? <div className="flex items-center gap-3 rounded-md bg-muted p-3"><FileText className="h-5 w-5 text-primary" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{receiptFile.name}</p><p className="text-xs text-muted-foreground">{(receiptFile.size / 1024 / 1024).toFixed(2)} MB</p></div><Button type="button" size="icon-sm" variant="ghost" onClick={() => setReceiptFile(null)} aria-label="Remover comprovante"><X className="h-4 w-4" /></Button></div> : <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border bg-background px-4 py-3 text-sm transition hover:bg-muted"><Upload className="h-4 w-4" />Selecionar comprovante<input type="file" className="sr-only" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => selectReceipt(event.target.files?.[0] ?? null)} /></label>}
            <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><Paperclip className="h-3 w-3" /> PDF, JPG, PNG ou WebP · máximo de 10 MB</p>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setBatchOpen(false)} disabled={saving}>Cancelar</Button><Button onClick={addBatch} disabled={saving || selectedAdjustments.length === 0}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Confirmar entrada</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Metric({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return <Card><CardContent className="pt-5"><p className="text-xs text-muted-foreground">{title}</p><p className="mt-1 text-2xl font-bold">{value}</p>{detail && <p className="mt-1 text-xs text-amber-400">{detail}</p>}</CardContent></Card>;
}

function TabGuide({ title, description, tips }: { title: string; description: string; tips: string[] }) {
  return <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.06] p-4 sm:p-5"><div className="flex items-start gap-3"><span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-400"><Info className="h-5 w-5" /></span><div className="min-w-0"><h2 className="font-semibold text-foreground">{title}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p><ul className="mt-3 grid gap-2 text-xs text-muted-foreground lg:grid-cols-3">{tips.map((tip) => <li key={tip} className="rounded-lg border border-border/70 bg-background/50 px-3 py-2 leading-5">{tip}</li>)}</ul></div></div></div>;
}
