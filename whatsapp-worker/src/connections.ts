import { supabaseAdmin } from './supabase-admin.js';

export type ConnectionStatus = 'disconnected' | 'qr_pending' | 'connected';

export interface ConnectionUpdate {
  status: ConnectionStatus;
  qr_code?: string | null;
  phone_number?: string | null;
  connected_at?: string | null;
}

/**
 * Upsert this account's `baileys_connections` row. The worker is the
 * sole writer of this table (Next.js only reads it, via RLS, for the
 * Settings UI's status/QR display) — see `connect`/`disconnect` routes
 * in the main app for the read side.
 */
export async function updateConnectionStatus(
  accountId: string,
  update: ConnectionUpdate,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('baileys_connections')
    .upsert(
      {
        account_id: accountId,
        last_seen_at: new Date().toISOString(),
        ...update,
      },
      { onConflict: 'account_id' },
    );
  if (error) {
    console.error(`[connections] failed to update status for ${accountId}:`, error.message);
  }
}

export async function clearAuthKeys(accountId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('baileys_auth_keys')
    .delete()
    .eq('account_id', accountId);
  if (error) {
    console.error(`[connections] failed to clear auth keys for ${accountId}:`, error.message);
  }
}

/**
 * Account ids that should auto-reconnect on worker startup — anything
 * previously connected, so a worker restart/redeploy doesn't force
 * every account to re-scan a QR code.
 */
export async function listConnectedAccountIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('baileys_connections')
    .select('account_id')
    .eq('status', 'connected');
  if (error) {
    console.error('[connections] failed to list connected accounts:', error.message);
    return [];
  }
  return (data ?? []).map((row) => row.account_id as string);
}
