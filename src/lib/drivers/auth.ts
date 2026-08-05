import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function getCurrentDriver() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabaseAdmin().from('delivery_drivers').select('*').eq('auth_user_id', user.id).eq('status', 'active').maybeSingle();
  return data;
}
