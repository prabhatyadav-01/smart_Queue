'use strict';

const { createClient } = require('@supabase/supabase-js');

let supabaseAdmin = null;

/**
 * Initializes and returns the server-side Supabase client with admin/service-role rights.
 * This client is used only server-side to verify JWT tokens and manage Supabase Auth.
 */
function getSupabaseAdmin({ supabaseUrl, supabaseServiceRoleKey } = {}) {
  const url = supabaseUrl || process.env.SUPABASE_URL || '';
  const key = supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

  if (!url || !key) {
    return null;
  }

  if (!supabaseAdmin) {
    supabaseAdmin = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return supabaseAdmin;
}

/**
 * Verifies a Supabase access token / session JWT on the server.
 * Returns { user, error }.
 */
async function verifySupabaseToken(token, options = {}) {
  const supabase = getSupabaseAdmin(options);
  if (!supabase) {
    return { user: null, error: new Error('Supabase is not configured on this server.') };
  }
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return { user: null, error: error || new Error('Invalid Supabase token') };
    }
    return { user, error: null };
  } catch (err) {
    return { user: null, error: err };
  }
}

module.exports = {
  getSupabaseAdmin,
  verifySupabaseToken,
};
