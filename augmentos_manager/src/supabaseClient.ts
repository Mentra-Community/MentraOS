// supabaseClient.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
// Import your env vars from '@env'
// import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@env'; 
import { AppState } from 'react-native';

const SUPABASE_URL = process.env.SUPABASE_URL as string || "https://auth.augmentos.org";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY as string || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrYml1bnpmYmJ0d2x6ZHBybWVoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzQyODA2OTMsImV4cCI6MjA0OTg1NjY5M30.rbEsE8IRz-gb3-D0H8VAJtGw-xvipl1Nc-gCnnQ748U";

console.log("\n\n\n\n\n\n\nSUPABASE KEY:");
console.log(SUPABASE_URL);
console.log(SUPABASE_ANON_KEY);
console.log("\n\n\n\n\n\n");

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});


// Tells Supabase Auth to continuously refresh the session automatically
// if the app is in the foreground. When this is added, you will continue
// to receive `onAuthStateChange` events with the `TOKEN_REFRESHED` or
// `SIGNED_OUT` event if the user's session is terminated. This should
// only be registered once.
AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh()
    } else {
      supabase.auth.stopAutoRefresh()
    }
  })
  