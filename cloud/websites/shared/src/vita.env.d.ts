/// <reference types="vite/client" />

interface ImportMetaEnv {
  //Adding both urls because account user CLOUD_API_URL and console uses VITE_API_URL.
  readonly VITE_CLOUD_API_URL: string
  readonly VITE_API_URL: string
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}