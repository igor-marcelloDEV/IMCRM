# IMCRM — Apresentação do sistema

> CRM completo para negócios que vendem pelo WhatsApp: do primeiro
> contato até a entrega na porta, em um único painel.

## O que é

O IMCRM nasceu como um CRM para WhatsApp — caixa de entrada
compartilhada, contatos e funil de vendas — e cresceu para cobrir a
operação inteira de um negócio que vende por conversa: catálogo, loja
online, pedidos, cobrança, entrega e um bot que atende sozinho fora do
horário. Tudo em um painel único, com a marca do próprio negócio.

Não é um SaaS genérico com preço por assento: cada instalação roda na
infraestrutura do dono (Supabase + Vercel), com os dados do próprio
negócio, sem depender de terceiros para continuar funcionando.

## O fluxo completo, de ponta a ponta

1. **Cliente manda mensagem no WhatsApp** → cai na caixa de entrada
   compartilhada, atribuída a um atendente, com histórico e tags do
   contato à mão.
2. **Sem atendente disponível?** O bot de automações conduz a conversa
   sozinho — catálogo, carrinho, adicionais, checkout — e só passa pra
   um humano quando precisa.
3. **Cliente monta o pedido** — pelo bot ou pela loja pública
   (`/loja/sua-marca`), escolhendo adicionais configurados por produto
   (ex: sabor, cobertura, ponto da carne) e decidindo entre retirar na
   loja (com horário e limite de gente por horário) ou receber em casa.
4. **Pagamento** via PIX ou cartão (Asaas), com nota gerada
   automaticamente quando configurado.
5. **Preparo e entrega** acompanhados num quadro operacional
   (Confirmado → Em preparo → Pronto → Saiu pra entrega → Entregue).
   Se for entrega, a corrida fica disponível para os entregadores
   cadastrados aceitarem — o primeiro a aceitar fica com ela, sem
   choque entre dois entregadores pegando o mesmo pedido.
6. **Repasse ao entregador** registrado automaticamente na entrega, com
   o painel controlando o que já foi pago.
7. **Negócio fechado** vira um card no funil de vendas, e a
   conversa/pedido inteiro fica no histórico do contato.

## Módulos

- **Caixa de entrada** — WhatsApp oficial (Meta Cloud API) ou WhatsApp
  Web (Baileys), múltiplos atendentes, atribuição, notas internas,
  respostas rápidas, mensagens de mídia (foto, vídeo, áudio, documento).
- **Contatos** — tags, campos customizados, importação em massa.
- **Funis de vendas (Kanban)** — negócios ligados a conversas e pedidos.
- **Catálogo** — produtos e serviços com foto, preço, estoque e
  **adicionais configuráveis** (grupos de opções com preço, obrigatórios
  ou não, ex: "Calda: Chocolate +R$3").
- **Pedidos / Comandas** — vendas no balcão ou por telefone, com os
  mesmos adicionais e cálculo automático do total.
- **Loja pública** — link próprio (`/loja/sua-marca`) pra vender sem
  depender de o cliente já ter conversado no WhatsApp; escolha entre
  retirada (com horário e capacidade) ou entrega (com endereço e GPS).
- **Entregadores** — cadastro autônomo (o próprio entregador se
  cadastra pelo celular), quadro de corridas disponíveis estilo
  aplicativo de entrega, aviso automático por WhatsApp quando surge uma
  corrida nova, e controle de repasse — o IMCRM é o intermediário, não
  o empregador.
- **Automações / Bot** — fluxos visuais no-code: gatilhos por palavra-
  chave, novo contato ou agendamento; catálogo e checkout completos
  dentro da própria conversa do WhatsApp.
- **Disparos em massa** — campanhas com templates aprovados pela Meta,
  rastreamento de entrega e leitura.
- **Assistente de IA** — respostas sugeridas no atendimento, atendimento
  automático fora do horário com handoff limpo pra humano, e uma base
  de conhecimento própria (FAQs, políticas, catálogo) que a IA consulta
  antes de responder.
- **Cobrança** — PIX e cartão via Asaas, assinaturas recorrentes, nota
  fiscal (NFS-e) quando configurado.
- **App instalável e offline** — o painel interno pode ser instalado
  como app (ícone na tela, tela cheia) e continua funcionando para
  tirar pedidos mesmo com a internet instável, sincronizando sozinho
  quando a conexão volta.
- **Equipe multiusuário** — convite por link, papéis (dono / admin /
  atendente / visualizador), tudo isolado por conta.
- **API pública + MCP** — para quem quer construir automações próprias
  em cima do CRM, inclusive via assistentes de IA (Claude, Cursor).

## Diferenciais

- **Dono dos dados** — roda na infraestrutura do próprio negócio, sem
  aluguel por assento nem trava de fornecedor.
- **Marca própria (whitelabel)** — logo e identidade do negócio em
  recibos, loja pública e nas mensagens.
- **Um só painel** para o que hoje costuma estar espalhado em 3-4
  ferramentas diferentes: atendimento, catálogo/loja, pedidos e
  logística de entrega.
- **Feito para operação real** — funciona no dia a dia de quem
  literalmente está com o celular na mão atendendo, tirando pedido no
  balcão ou entregando na rua.

## Stack técnico

Next.js 16 (App Router) na Vercel, Supabase (Postgres + Auth +
Storage) como banco, WhatsApp (Meta Cloud API ou Baileys), Asaas para
pagamento e nota fiscal. Detalhes de arquitetura em
[`docs/architecture.md`](./architecture.md).
