# imcrm-whatsapp-worker

Segunda opção de conexão do WhatsApp para o IMCRM: **API não-oficial**,
via [Baileys](https://github.com/WhiskeySockets/Baileys) (protocolo do
WhatsApp Web — o mesmo "escaneie o QR code" que qualquer usuário já
conhece). Isso é uma alternativa à **Meta Cloud API** oficial já usada
pelo app principal.

## Por que este serviço existe separado do app Next.js

O app principal roda na Vercel como funções serverless — sem processo
de longa duração, sem WebSocket persistente entre requisições. O
Baileys precisa manter uma conexão WebSocket aberta com os servidores
do WhatsApp o tempo todo. Esses dois modelos são incompatíveis, então
o cliente Baileys vive aqui, num processo Node separado e sempre
ligado, que o app principal chama por HTTP.

## Arquitetura

```
Next.js app  <--HTTP (Bearer WORKER_API_SECRET)-->  este worker  <--WebSocket-->  WhatsApp
     ^                                                    |
     |                POST /api/whatsapp/worker-webhook   |
     +----------------------------------------------------+
              (mensagens recebidas)
```

- **Saída** (app → WhatsApp): o app chama `POST /send/:accountId` aqui.
- **Entrada** (WhatsApp → app): este worker recebe a mensagem via
  Baileys e faz `POST /api/whatsapp/worker-webhook` no app principal.
- **Pareamento** (QR code): o app chama `POST /connect/:accountId`;
  este worker abre a sessão Baileys, gera o QR e grava o status/QR
  diretamente na tabela `baileys_connections` (o app só lê essa
  tabela via Supabase, com RLS, para exibir o QR na tela de
  Configurações — sem endpoint HTTP dedicado para isso).
- **Sessão** (chaves do protocolo Signal do Baileys): persistidas
  criptografadas na tabela `baileys_auth_keys`, uma linha por chave,
  em vez do arquivo local padrão do Baileys — assim a sessão sobrevive
  a um restart/redeploy deste processo.

Um único worker atende **todas** as contas que escolherem WhatsApp Web
— cada conta tem seu próprio socket Baileys em memória, mas é o mesmo
processo.

## Rodando localmente

```bash
cp .env.example .env
# preencha SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY
# (mesmo valor do .env do app principal), WORKER_API_SECRET e
# APP_BASE_URL

npm install
npm run dev
```

No app principal, defina (no `.env.local` ou nas envs da Vercel):

```
WHATSAPP_WORKER_URL=http://localhost:3100   # ou a URL pública do worker em produção
WORKER_API_SECRET=<o mesmo valor definido aqui>
```

## Deploy (opções documentadas, nenhuma fixada no código)

Este worker só precisa de: um processo Node sempre ligado + uma URL
HTTPS pública. Três caminhos razoáveis:

- **Railway** — deploy direto do repo (Dockerfile incluso), rápido
  para começar.
- **Fly.io** — máquinas persistentes com IP dedicado (útil para a
  sessão do WhatsApp parecer sempre vir do mesmo lugar).
- **VPS próprio** (Hetzner/DigitalOcean) + PM2 ou systemd — mais
  controle, mais responsabilidade de manutenção.

## Rotas HTTP

Todas (exceto `/health`) exigem `Authorization: Bearer <WORKER_API_SECRET>`.

| Rota | Método | Descrição |
|---|---|---|
| `/health` | GET | Health check, sem auth. |
| `/connect/:accountId` | POST | Inicia (ou reinicia) o pareamento por QR. |
| `/disconnect/:accountId` | POST | Encerra a sessão e apaga as chaves salvas. |
| `/send/:accountId` | POST | Envia uma mensagem. Corpo: ver `src/baileys-client.ts` (`SendRequest`). |

## Limitações conhecidas (v1)

- **Sem mensagens interativas** (botões/listas) — não suportadas pelo
  protocolo não-oficial de forma confiável; tentativas retornam erro
  claro no app principal.
- **Sem citação/reply real** — Baileys exige o objeto completo da
  mensagem original para citar, e este worker não mantém um cache de
  mensagens; o envio funciona, só não aparece como "resposta a" no
  WhatsApp.
- **Apenas conversas 1:1** — mensagens de grupo (`@g.us`) são
  ignoradas.
- **Risco de banimento do número** — por não ser uma API oficial, uso
  abusivo (principalmente disparos em massa) pode levar o WhatsApp a
  bloquear o número. O app exibe esse aviso na tela de Configurações e
  no composer de Broadcast.
