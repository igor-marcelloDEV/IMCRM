import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { supabaseAdmin } from './supabase-admin.js';
import { encrypt, decrypt } from './encryption.js';
import { config } from './config.js';

/**
 * Baileys' "auth state" is normally persisted to local JSON files
 * (`useMultiFileAuthState`) — fine for a script on your laptop, fatal
 * for a process that gets redeployed/restarted (the whole point of
 * hosting this on a real platform). This is the same interface
 * (`{ creds, keys: { get, set } }`) backed by the `baileys_auth_keys`
 * table instead, one encrypted row per key, keyed by
 * (account_id, key_type, key_id) — see migration
 * 037_baileys_integration.sql for the schema + RLS rationale.
 */

async function readKey(accountId: string, keyType: string, keyId: string): Promise<unknown> {
  const { data, error } = await supabaseAdmin
    .from('baileys_auth_keys')
    .select('encrypted_value')
    .eq('account_id', accountId)
    .eq('key_type', keyType)
    .eq('key_id', keyId)
    .maybeSingle();
  if (error || !data) return null;
  try {
    return JSON.parse(decrypt(data.encrypted_value, config.encryptionKey), BufferJSON.reviver);
  } catch (err) {
    console.error(`[auth-state] failed to decrypt ${keyType}/${keyId} for ${accountId}:`, err);
    return null;
  }
}

async function writeKey(
  accountId: string,
  keyType: string,
  keyId: string,
  value: unknown,
): Promise<void> {
  if (value === null || value === undefined) {
    await supabaseAdmin
      .from('baileys_auth_keys')
      .delete()
      .eq('account_id', accountId)
      .eq('key_type', keyType)
      .eq('key_id', keyId);
    return;
  }
  const encryptedValue = encrypt(JSON.stringify(value, BufferJSON.replacer), config.encryptionKey);
  const { error } = await supabaseAdmin.from('baileys_auth_keys').upsert(
    { account_id: accountId, key_type: keyType, key_id: keyId, encrypted_value: encryptedValue },
    { onConflict: 'account_id,key_type,key_id' },
  );
  if (error) {
    console.error(`[auth-state] failed to persist ${keyType}/${keyId} for ${accountId}:`, error.message);
  }
}

export async function useSupabaseAuthState(accountId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const storedCreds = await readKey(accountId, 'creds', 'creds');
  const creds = (storedCreds as AuthenticationState['creds']) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readKey(accountId, type, id);
              // App-state-sync keys need to be rehydrated into their
              // protobuf type — Baileys does the same in every other
              // auth-state implementation (file, Redis, Mongo, …).
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as Record<string, unknown>,
                );
              }
              if (value) {
                result[id] = value as SignalDataTypeMap[typeof type];
              }
            }),
          );
          return result;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            const categoryData = data[category];
            if (!categoryData) continue;
            for (const id of Object.keys(categoryData)) {
              tasks.push(writeKey(accountId, category, id, categoryData[id]));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeKey(accountId, 'creds', 'creds', creds),
  };
}
