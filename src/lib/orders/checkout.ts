import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createOrGetCustomer,
  createOrGetPixPayment,
  getPixQrCode,
  type AsaasPixQrCode,
} from '@/lib/billing/asaas';
import { validateBrazilianTaxId } from '@/lib/brazilian-tax-id';
import { getTenantAsaasConfig } from './tenant-asaas';

export interface CheckoutOrderClaim {
  orderId: string;
  cartId: string;
  totalCents: number;
  currency: string;
  created: boolean;
}

export interface CheckoutPixSuccess {
  ok: true;
  orderId: string;
  totalCents: number;
  currency: string;
  pixCopyPaste: string;
  reusedGatewayPayment: boolean;
}

export interface CheckoutPixFailure {
  ok: false;
  orderId: string;
  code: string;
  retryMessage: string;
}

export type CheckoutPixResult = CheckoutPixSuccess | CheckoutPixFailure;

interface CheckoutOrderRow {
  id: string;
  account_id: string;
  contact_id: string | null;
  cart_id: string | null;
  status: 'pending_payment' | 'paid' | 'canceled';
  total_cents: number;
  currency: string;
  gateway_customer_id: string | null;
  gateway_payment_id: string | null;
  pix_copy_paste: string | null;
  pix_expires_at: string | null;
}

interface CheckoutContactRow {
  name: string | null;
  email: string | null;
  phone: string;
  cpf_cnpj: string | null;
}

interface CheckoutDependencies {
  getTenantConfig: typeof getTenantAsaasConfig;
  createOrGetCustomer: typeof createOrGetCustomer;
  createOrGetPixPayment: typeof createOrGetPixPayment;
  getPixQrCode: typeof getPixQrCode;
  now: () => Date;
}

const defaultDependencies: CheckoutDependencies = {
  getTenantConfig: getTenantAsaasConfig,
  createOrGetCustomer,
  createOrGetPixPayment,
  getPixQrCode,
  now: () => new Date(),
};

const PAYMENT_RETRY_MESSAGE =
  'Não consegui gerar o PIX agora. Aguarde um minuto e responda TENTAR NOVAMENTE.';
const PAYMENT_BUSY_MESSAGE =
  'Seu PIX já está sendo gerado. Aguarde alguns segundos e responda TENTAR NOVAMENTE.';

export class CheckoutPersistenceError extends Error {
  constructor(operation: string, detail?: string) {
    super(
      detail
        ? `${operation}: ${detail}`
        : `Falha de persistência durante ${operation}`
    );
    this.name = 'CheckoutPersistenceError';
  }
}

function persistenceError(
  operation: string,
  error: { message?: string } | null | undefined
): CheckoutPersistenceError {
  return new CheckoutPersistenceError(operation, error?.message);
}

export async function claimCheckoutOrder(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    conversationId: string | null;
    userId: string;
    pipelineId: string;
    stageId: string;
  }
): Promise<CheckoutOrderClaim | null> {
  const { data, error } = await db
    .rpc('claim_cart_checkout', {
      p_account_id: args.accountId,
      p_contact_id: args.contactId,
      p_conversation_id: args.conversationId,
      p_user_id: args.userId,
      p_pipeline_id: args.pipelineId,
      p_stage_id: args.stageId,
    })
    .maybeSingle();
  if (error) throw persistenceError('claim_cart_checkout', error);
  if (!data) return null;

  const row = data as {
    order_id: string;
    cart_id: string;
    total_cents: number;
    currency: string;
    created: boolean;
  };
  return {
    orderId: row.order_id,
    cartId: row.cart_id,
    totalCents: row.total_cents,
    currency: row.currency,
    created: row.created,
  };
}

async function loadCheckoutOrder(
  db: SupabaseClient,
  accountId: string,
  orderId: string
): Promise<CheckoutOrderRow | null> {
  const { data, error } = await db
    .from('orders')
    .select(
      'id, account_id, contact_id, cart_id, status, total_cents, currency, gateway_customer_id, gateway_payment_id, pix_copy_paste, pix_expires_at'
    )
    .eq('id', orderId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw persistenceError('load checkout order', error);
  return data as CheckoutOrderRow | null;
}

async function completePixPersistence(
  db: SupabaseClient,
  args: {
    orderId: string;
    accountId: string;
    claimToken: string | null;
    gatewayCustomerId: string | null;
    gatewayPaymentId: string;
    qrCode: AsaasPixQrCode;
  }
): Promise<CheckoutOrderRow | null> {
  const { data, error } = await db
    .rpc('complete_order_pix_charge', {
      p_order_id: args.orderId,
      p_account_id: args.accountId,
      p_claim_token: args.claimToken,
      p_gateway_customer_id: args.gatewayCustomerId,
      p_gateway_payment_id: args.gatewayPaymentId,
      p_pix_copy_paste: args.qrCode.payload,
      p_pix_expires_at: args.qrCode.expirationDate || null,
    })
    .maybeSingle();
  if (error) throw persistenceError('complete_order_pix_charge', error);
  if (!data) return null;

  const completed = data as {
    order_id: string;
    cart_id: string | null;
    total_cents: number;
    currency: string;
    gateway_payment_id: string;
    pix_copy_paste: string;
    pix_expires_at: string | null;
  };
  return {
    id: completed.order_id,
    account_id: args.accountId,
    contact_id: null,
    cart_id: completed.cart_id,
    status: 'pending_payment',
    total_cents: completed.total_cents,
    currency: completed.currency,
    gateway_customer_id: args.gatewayCustomerId,
    gateway_payment_id: completed.gateway_payment_id,
    pix_copy_paste: completed.pix_copy_paste,
    pix_expires_at: completed.pix_expires_at,
  };
}

export async function recordCheckoutOperationalError(
  db: SupabaseClient,
  args: {
    orderId: string;
    accountId: string;
    claimToken?: string | null;
    code: string;
    detail: string;
    holdClaim?: boolean;
  }
): Promise<void> {
  const { data, error } = await db.rpc('record_order_checkout_error', {
    p_order_id: args.orderId,
    p_account_id: args.accountId,
    p_claim_token: args.claimToken ?? null,
    p_error_code: args.code,
    p_error_detail: args.detail,
    p_hold_claim: args.holdClaim ?? false,
  });
  if (error) throw persistenceError('record_order_checkout_error', error);
  if (data !== true) {
    throw new CheckoutPersistenceError(
      'record_order_checkout_error',
      'pedido/claim não encontrado'
    );
  }
}

export async function clearCheckoutOperationalError(
  db: SupabaseClient,
  orderId: string,
  accountId: string
): Promise<void> {
  const { data, error } = await db.rpc('clear_order_checkout_error', {
    p_order_id: orderId,
    p_account_id: accountId,
  });
  if (error) throw persistenceError('clear_order_checkout_error', error);
  if (data !== true) {
    throw new CheckoutPersistenceError(
      'clear_order_checkout_error',
      'pedido não encontrado'
    );
  }
}

async function failCheckout(
  db: SupabaseClient,
  args: {
    orderId: string;
    accountId: string;
    claimToken?: string | null;
    code: string;
    error: unknown;
    holdClaim?: boolean;
    retryMessage?: string;
  }
): Promise<CheckoutPixFailure> {
  const detail =
    args.error instanceof Error ? args.error.message : String(args.error);
  await recordCheckoutOperationalError(db, {
    orderId: args.orderId,
    accountId: args.accountId,
    claimToken: args.claimToken,
    code: args.code,
    detail,
    holdClaim: args.holdClaim,
  });
  return {
    ok: false,
    orderId: args.orderId,
    code: args.code,
    retryMessage: args.retryMessage ?? PAYMENT_RETRY_MESSAGE,
  };
}

export async function ensureCheckoutPix(
  db: SupabaseClient,
  args: {
    accountId: string;
    orderId: string;
    contactId: string;
  },
  dependencyOverrides: Partial<CheckoutDependencies> = {}
): Promise<CheckoutPixResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  let order = await loadCheckoutOrder(db, args.accountId, args.orderId);
  if (!order) {
    throw new CheckoutPersistenceError(
      'load checkout order',
      'pedido não encontrado'
    );
  }
  if (order.contact_id !== args.contactId) {
    throw new CheckoutPersistenceError(
      'load checkout order',
      'pedido não pertence ao contato informado'
    );
  }
  if (
    order.status === 'paid' &&
    order.gateway_payment_id &&
    order.pix_copy_paste
  ) {
    return {
      ok: true,
      orderId: order.id,
      totalCents: order.total_cents,
      currency: order.currency,
      pixCopyPaste: order.pix_copy_paste,
      reusedGatewayPayment: true,
    };
  }
  if (order.status !== 'pending_payment') {
    return {
      ok: false,
      orderId: order.id,
      code: 'order_not_pending',
      retryMessage:
        'Este pedido não está mais aguardando pagamento. Fale com a equipe para conferir.',
    };
  }

  if (order.gateway_payment_id && order.pix_copy_paste) {
    try {
      const completed = await completePixPersistence(db, {
        orderId: order.id,
        accountId: args.accountId,
        claimToken: null,
        gatewayCustomerId: order.gateway_customer_id,
        gatewayPaymentId: order.gateway_payment_id,
        qrCode: {
          payload: order.pix_copy_paste,
          encodedImage: '',
          expirationDate: order.pix_expires_at ?? '',
        },
      });
      if (!completed?.pix_copy_paste) {
        throw new CheckoutPersistenceError(
          'recover completed PIX checkout',
          'cobrança correlacionada não pôde ser finalizada'
        );
      }
      return {
        ok: true,
        orderId: completed.id,
        totalCents: completed.total_cents,
        currency: completed.currency,
        pixCopyPaste: completed.pix_copy_paste,
        reusedGatewayPayment: true,
      };
    } catch (error) {
      return failCheckout(db, {
        orderId: order.id,
        accountId: args.accountId,
        code: 'pix_completion_recovery_failed',
        error,
      });
    }
  }

  let config;
  try {
    config = await dependencies.getTenantConfig(db, args.accountId);
  } catch (error) {
    return failCheckout(db, {
      orderId: order.id,
      accountId: args.accountId,
      code: 'asaas_config_load_failed',
      error,
    });
  }
  if (!config) {
    return failCheckout(db, {
      orderId: order.id,
      accountId: args.accountId,
      code: 'asaas_not_configured',
      error: new Error('Conta Asaas não configurada ou credencial inválida'),
      retryMessage:
        'Não foi possível gerar o PIX porque o pagamento ainda não está configurado. Fale com a equipe.',
    });
  }

  if (order.gateway_payment_id) {
    try {
      const qrCode = await dependencies.getPixQrCode(
        config,
        order.gateway_payment_id
      );
      const completed = await completePixPersistence(db, {
        orderId: order.id,
        accountId: args.accountId,
        claimToken: null,
        gatewayCustomerId: order.gateway_customer_id,
        gatewayPaymentId: order.gateway_payment_id,
        qrCode,
      });
      if (!completed?.pix_copy_paste) {
        throw new Error('PIX existente não pôde ser reconciliado');
      }
      return {
        ok: true,
        orderId: completed.id,
        totalCents: completed.total_cents,
        currency: completed.currency,
        pixCopyPaste: completed.pix_copy_paste,
        reusedGatewayPayment: true,
      };
    } catch (error) {
      return failCheckout(db, {
        orderId: order.id,
        accountId: args.accountId,
        code: 'pix_recovery_failed',
        error,
      });
    }
  }

  const { data: contactData, error: contactError } = await db
    .from('contacts')
    .select('name, email, phone, cpf_cnpj')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (contactError) {
    return failCheckout(db, {
      orderId: order.id,
      accountId: args.accountId,
      code: 'checkout_contact_load_failed',
      error: persistenceError('load checkout contact', contactError),
    });
  }
  const contact = contactData as CheckoutContactRow | null;
  if (!contact) {
    return failCheckout(db, {
      orderId: order.id,
      accountId: args.accountId,
      code: 'checkout_contact_missing',
      error: new Error('Contato do pedido não encontrado'),
    });
  }
  const taxId = contact.cpf_cnpj
    ? validateBrazilianTaxId(contact.cpf_cnpj)
    : null;
  if (!taxId) {
    return failCheckout(db, {
      orderId: order.id,
      accountId: args.accountId,
      code: 'invalid_cpf_cnpj',
      error: new Error('CPF/CNPJ ausente ou inválido'),
      retryMessage:
        'O CPF/CNPJ deste pedido é inválido. Envie novamente os 11 dígitos do CPF ou 14 do CNPJ.',
    });
  }

  const { data: claimData, error: claimError } = await db
    .rpc('claim_order_payment_attempt', {
      p_order_id: order.id,
      p_account_id: args.accountId,
      p_lease_seconds: 90,
    })
    .maybeSingle();
  if (claimError) {
    return failCheckout(db, {
      orderId: order.id,
      accountId: args.accountId,
      code: 'payment_claim_failed',
      error: persistenceError('claim_order_payment_attempt', claimError),
    });
  }
  if (!claimData) {
    return {
      ok: false,
      orderId: order.id,
      code: 'payment_attempt_in_progress',
      retryMessage: PAYMENT_BUSY_MESSAGE,
    };
  }
  const claimToken = (claimData as { claim_token: string }).claim_token;

  let customer: { id: string };
  let pix: Awaited<ReturnType<typeof createOrGetPixPayment>>;
  try {
    customer = await dependencies.createOrGetCustomer({
      config,
      name: contact.name || 'Cliente WhatsApp',
      email: contact.email || `contato-${args.contactId}@sememail.imcrm.app`,
      phone: contact.phone,
      cpfCnpj: taxId.normalized,
      externalReference: args.contactId,
    });
    const dueDate = new Date(dependencies.now().getTime() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    pix = await dependencies.createOrGetPixPayment({
      config,
      customerId: customer.id,
      value: order.total_cents / 100,
      dueDate,
      description: 'Pedido via WhatsApp',
      externalReference: order.id,
    });
  } catch (error) {
    return failCheckout(db, {
      orderId: order.id,
      accountId: args.accountId,
      claimToken,
      code: 'asaas_charge_failed',
      error,
      // Preserve the lease for an ambiguous provider/network failure.
      // The retry first reconciles by externalReference.
      holdClaim: true,
    });
  }

  let completed: CheckoutOrderRow | null;
  try {
    completed = await completePixPersistence(db, {
      orderId: order.id,
      accountId: args.accountId,
      claimToken,
      gatewayCustomerId: customer.id,
      gatewayPaymentId: pix.payment.id,
      qrCode: pix.qrCode,
    });
  } catch (error) {
    return failCheckout(db, {
      orderId: order.id,
      accountId: args.accountId,
      claimToken,
      code: 'pix_persistence_failed',
      error,
      holdClaim: true,
    });
  }
  if (!completed?.pix_copy_paste) {
    order = await loadCheckoutOrder(db, args.accountId, args.orderId);
    if (order?.gateway_payment_id && order.pix_copy_paste) {
      return {
        ok: true,
        orderId: order.id,
        totalCents: order.total_cents,
        currency: order.currency,
        pixCopyPaste: order.pix_copy_paste,
        reusedGatewayPayment: true,
      };
    }
    return failCheckout(db, {
      orderId: args.orderId,
      accountId: args.accountId,
      claimToken,
      code: 'pix_persistence_lost_race',
      error: new Error('A tentativa não concluiu a persistência do PIX'),
      holdClaim: true,
    });
  }

  return {
    ok: true,
    orderId: completed.id,
    totalCents: completed.total_cents,
    currency: completed.currency,
    pixCopyPaste: completed.pix_copy_paste,
    reusedGatewayPayment: pix.reused,
  };
}
