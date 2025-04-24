// utils/supabase.ts
import { createClient } from '@supabase/supabase-js';

// Access Vite environment variables
// These variables must be prefixed with VITE_ in your .env file
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || '';


if (!supabaseUrl) {
  console.error('Missing Supabase environment variables');
}

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});