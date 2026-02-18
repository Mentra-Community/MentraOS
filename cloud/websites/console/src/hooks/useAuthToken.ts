// src/hooks/useAuthToken.ts
import { useEffect, useState } from 'react'
import { supabase } from '@mentra/shared'

export function useAuthToken() {
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function getToken() {
      const { data } = await supabase.auth.getSession()
      setToken(data.session?.access_token || null)
      setLoading(false)
    }

    getToken()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setToken(session?.access_token || null)
    })

    return () => subscription.unsubscribe()
  }, [])

  return { token, loading }
}