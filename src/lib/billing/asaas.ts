/**
 * Asaas gateway client — thin REST wrapper, no SDK (same style as
 * src/lib/whatsapp/meta-api.ts). Asaas is a Brazilian payment gateway
 * built for SaaS-style recurring billing: native Subscription objects
 * with WEEKLY/MONTHLY/YEARLY cycles, PIX/boleto/credit-card billing
 * types, and a sandbox environment that's free to create.
 *
 * Docs: https://docs.asaas.com
 *
 * Every function takes a single options object (named params) — see
 * meta-api.ts's header comment for why (a swapped-positional-args bug
 * found repeatedly in that file).
 */

export type AsaasEnv = 'sandbox' | 'production'
export type AsaasCycle = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUALLY' | 'YEARLY'
export type AsaasBillingType = 'PIX' | 'BOLETO' | 'CREDIT_CARD'

function baseUrl(env: AsaasEnv): string {
  return env === 'production'
    ? 'https://api.asaas.com/v3'
    : 'https://sandbox.asaas.com/api/v3'
}

export interface AsaasClientConfig {
  apiKey: string
  env: AsaasEnv
}

interface AsaasErrorResponse {
  errors?: Array<{ code?: string; description?: string }>
}

async function asaasFetch<T>(
  config: AsaasClientConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${baseUrl(config.env)}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      access_token: config.apiKey,
      ...(init.headers ?? {}),
    },
  })

  if (!response.ok) {
    let message = `Asaas API error: ${response.status}`
    try {
      const data = (await response.json()) as AsaasErrorResponse
      const first = data.errors?.[0]
      if (first?.description) message = first.description
    } catch {
      // response body wasn't JSON — keep the fallback
    }
    throw new Error(message)
  }

  return response.json() as Promise<T>
}

// ============================================================
// Customers
// ============================================================

export interface AsaasCustomer {
  id: string
  name: string
  email: string
  phone?: string
  cpfCnpj?: string | null
}

export interface CreateOrGetCustomerArgs {
  config: AsaasClientConfig
  name: string
  email: string
  phone: string
  /** Required by Asaas to create ANY charge (PIX/boleto/card) — a
   *  customer with no CPF/CNPJ on file makes payment creation fail
   *  with "Para criar esta cobrança é necessário preencher o CPF ou
   *  CNPJ do cliente." Digits only, 11 (CPF) or 14 (CNPJ). */
  cpfCnpj: string
  /** `contacts.id` — lets us find the Asaas customer back from our
   *  own id without storing a second mapping table. */
  externalReference: string
}

/**
 * Asaas has no "upsert customer" endpoint — `externalReference` is
 * the only unique-per-account key we control, so look it up first
 * and only create when nothing matches. Idempotent across retries.
 *
 * When an existing customer is found but is missing (or has a stale)
 * cpfCnpj, patches it in place — this is what lets a customer created
 * before this field was collected (or before the caller had it handy)
 * still succeed on their next checkout attempt without creating a
 * second, duplicate Asaas customer.
 */
export async function createOrGetCustomer(
  args: CreateOrGetCustomerArgs,
): Promise<AsaasCustomer> {
  const { config, name, email, phone, cpfCnpj, externalReference } = args

  const existing = await asaasFetch<{ data: AsaasCustomer[] }>(
    config,
    `/customers?externalReference=${encodeURIComponent(externalReference)}`,
  )
  if (existing.data.length > 0) {
    const customer = existing.data[0]
    if (customer.cpfCnpj === cpfCnpj) return customer
    return asaasFetch<AsaasCustomer>(config, `/customers/${customer.id}`, {
      method: 'PUT',
      body: JSON.stringify({ cpfCnpj }),
    })
  }

  return asaasFetch<AsaasCustomer>(config, '/customers', {
    method: 'POST',
    body: JSON.stringify({ name, email, phone, cpfCnpj, externalReference }),
  })
}

// ============================================================
// Subscriptions (card / boleto recurring)
// ============================================================

export interface AsaasSubscription {
  id: string
  status: string
  nextDueDate: string
}

export interface CreateSubscriptionArgs {
  config: AsaasClientConfig
  customerId: string
  cycle: AsaasCycle
  /** Reais, not cents — Asaas' API takes decimal amounts. */
  value: number
  billingType: Extract<AsaasBillingType, 'CREDIT_CARD' | 'BOLETO'>
  nextDueDate: string
  /** `subscriptions.id` (ours) — round-trips back on the webhook payload. */
  externalReference: string
}

export async function createSubscription(
  args: CreateSubscriptionArgs,
): Promise<AsaasSubscription> {
  const { config, customerId, cycle, value, billingType, nextDueDate, externalReference } = args
  return asaasFetch<AsaasSubscription>(config, '/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType,
      cycle,
      value,
      nextDueDate,
      externalReference,
    }),
  })
}

export async function cancelSubscription(
  config: AsaasClientConfig,
  gatewaySubscriptionId: string,
): Promise<void> {
  await asaasFetch(config, `/subscriptions/${gatewaySubscriptionId}`, {
    method: 'DELETE',
  })
}

/**
 * Asaas generates the subscription's first payment asynchronously at
 * creation time — there's no `invoiceUrl` on the Subscription object
 * itself. For the credit-card path we need that payment's hosted
 * checkout link to redirect the customer to, so fetch it right after
 * creating the subscription.
 */
export async function getFirstSubscriptionPaymentInvoiceUrl(
  config: AsaasClientConfig,
  gatewaySubscriptionId: string,
): Promise<string | null> {
  const result = await asaasFetch<{ data: Array<{ invoiceUrl: string }> }>(
    config,
    `/subscriptions/${gatewaySubscriptionId}/payments`,
  )
  return result.data[0]?.invoiceUrl ?? null
}

// ============================================================
// One-off PIX payment (no recurring mandate exists for PIX in
// Brazil today — see the plan doc. Each cycle is its own charge;
// renewal reminders are the nurture cron's job, not this client's.)
// ============================================================

export interface AsaasPixPayment {
  id: string
  status: string
  invoiceUrl: string
  customer?: string
  value?: number
  billingType?: AsaasBillingType
  externalReference?: string
}

export interface AsaasPixQrCode {
  encodedImage: string
  payload: string
  expirationDate: string
}

export interface CreatePixPaymentArgs {
  config: AsaasClientConfig
  customerId: string
  /** Reais, not cents. */
  value: number
  dueDate: string
  description: string
  externalReference: string
}

export async function createPixPayment(
  args: CreatePixPaymentArgs,
): Promise<{ payment: AsaasPixPayment; qrCode: AsaasPixQrCode }> {
  const { config, customerId, value, dueDate, description, externalReference } = args
  const payment = await asaasFetch<AsaasPixPayment>(config, '/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType: 'PIX',
      value,
      dueDate,
      description,
      externalReference,
    }),
  })
  const qrCode = await getPixQrCode(config, payment.id)
  return { payment, qrCode }
}

export async function getPixQrCode(
  config: AsaasClientConfig,
  paymentId: string,
): Promise<AsaasPixQrCode> {
  return asaasFetch<AsaasPixQrCode>(
    config,
    `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
  )
}

/**
 * Recover a charge created by an earlier ambiguous attempt before
 * creating another one. Asaas supports filtering payments by our
 * externalReference; the checkout uses the immutable order UUID.
 *
 * A local DB lease still serializes normal concurrent attempts. This
 * lookup covers the harder failure mode where Asaas accepted POST
 * /payments but the response or subsequent local persistence failed.
 */
export async function createOrGetPixPayment(
  args: CreatePixPaymentArgs,
): Promise<{
  payment: AsaasPixPayment
  qrCode: AsaasPixQrCode
  reused: boolean
}> {
  const { config, customerId, value, externalReference } = args
  const query = new URLSearchParams({
    externalReference,
    billingType: 'PIX',
    limit: '10',
  })
  const existing = await asaasFetch<{ data: AsaasPixPayment[] }>(
    config,
    `/payments?${query.toString()}`,
  )
  const payment = existing.data[0]

  if (payment) {
    if (payment.customer && payment.customer !== customerId) {
      throw new Error(
        'A cobrança existente não pertence ao cliente esperado.',
      )
    }
    if (
      typeof payment.value === 'number' &&
      Math.round(payment.value * 100) !== Math.round(value * 100)
    ) {
      throw new Error(
        'A cobrança existente não corresponde ao valor do pedido.',
      )
    }
    if (payment.billingType && payment.billingType !== 'PIX') {
      throw new Error('A cobrança existente não é PIX.')
    }
    return {
      payment,
      qrCode: await getPixQrCode(config, payment.id),
      reused: true,
    }
  }

  const created = await createPixPayment(args)
  return { ...created, reused: false }
}

export interface AsaasHostedCardPayment {
  id: string
  status: string
  invoiceUrl: string
  customer?: string
  value?: number
  billingType?: AsaasBillingType
  externalReference?: string
}

export interface CreateHostedCardPaymentArgs {
  config: AsaasClientConfig
  customerId: string
  value: number
  dueDate: string
  description: string
  externalReference: string
}

/**
 * Creates a hosted Asaas invoice instead of collecting card data in IMCRM.
 * Asaas exposes debit on its hosted invoice for CREDIT_CARD charges when the
 * merchant account is eligible; saved-card suggestions are owned by the
 * customer's browser/device.
 */
export async function createOrGetHostedCardPayment(
  args: CreateHostedCardPaymentArgs,
): Promise<{ payment: AsaasHostedCardPayment; reused: boolean }> {
  const { config, customerId, value, dueDate, description, externalReference } = args
  const query = new URLSearchParams({
    externalReference,
    billingType: 'CREDIT_CARD',
    limit: '10',
  })
  const existing = await asaasFetch<{ data: AsaasHostedCardPayment[] }>(
    config,
    `/payments?${query.toString()}`,
  )
  const payment = existing.data[0]
  if (payment) {
    if (payment.customer && payment.customer !== customerId) {
      throw new Error('A cobrança existente não pertence ao cliente esperado.')
    }
    if (typeof payment.value === 'number' && Math.round(payment.value * 100) !== Math.round(value * 100)) {
      throw new Error('A cobrança existente não corresponde ao valor do pedido.')
    }
    if (!payment.invoiceUrl) throw new Error('O Asaas não retornou o link de pagamento.')
    return { payment, reused: true }
  }

  const created = await asaasFetch<AsaasHostedCardPayment>(config, '/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType: 'CREDIT_CARD',
      value,
      dueDate,
      description,
      externalReference,
    }),
  })
  if (!created.invoiceUrl) throw new Error('O Asaas não retornou o link de pagamento.')
  return { payment: created, reused: false }
}

// ============================================================
// Boleto (also one-off per cycle, same rationale as PIX above)
// ============================================================

export interface CreateBoletoPaymentArgs {
  config: AsaasClientConfig
  customerId: string
  value: number
  dueDate: string
  description: string
  externalReference: string
}

export async function createBoletoPayment(
  args: CreateBoletoPaymentArgs,
): Promise<{ id: string; status: string; invoiceUrl: string; bankSlipUrl: string }> {
  const { config, customerId, value, dueDate, description, externalReference } = args
  return asaasFetch(config, '/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType: 'BOLETO',
      value,
      dueDate,
      description,
      externalReference,
    }),
  })
}

// ============================================================
// Config resolution
// ============================================================

/**
 * Reads ASAAS_API_KEY / ASAAS_ENV from the environment. Throws with a
 * clear message rather than sending an unauthenticated request if the
 * key hasn't been configured yet (e.g. before the sandbox account
 * exists) — callers should catch this and surface a friendly error
 * instead of a raw network failure.
 */
export function getAsaasConfig(): AsaasClientConfig {
  const apiKey = process.env.ASAAS_API_KEY
  if (!apiKey) {
    throw new Error(
      'ASAAS_API_KEY is not configured — billing is not wired up on this deployment yet.',
    )
  }
  const env: AsaasEnv = process.env.ASAAS_ENV === 'production' ? 'production' : 'sandbox'
  return { apiKey, env }
}
