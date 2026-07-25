import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

// Single service-role client for the whole process. Service role
// bypasses RLS entirely — required for baileys_auth_keys, which has
// no client-facing policy at all (see migration
// 037_baileys_integration.sql), and convenient for baileys_connections
// so status/QR updates don't need a signed-in user session.
export const supabaseAdmin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false },
});
