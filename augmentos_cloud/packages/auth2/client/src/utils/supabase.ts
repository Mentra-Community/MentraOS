// utils/supabase.ts
import { createClient } from '@supabase/supabase-js';

// Access Vite environment variables
// These variables must be prefixed with VITE_ in your .env file
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';


if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing Supabase environment variables');
}
// Client for browser usage
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true
  }
});