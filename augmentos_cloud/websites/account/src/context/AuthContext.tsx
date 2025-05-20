import React, { createContext, useContext, useEffect, useState } from 'react'
import { Session, User } from '@supabase/supabase-js'
import { supabase } from '../utils/supabase'
import axios from 'axios'

export type AuthContextType = {
  session: Session | null
  user: User | null
  loading: boolean
  isLoading: boolean
  isAuthenticated: boolean
  supabaseToken: string | null
  coreToken: string | null
  tokenReady: boolean
  signIn: (email: string, password: string) => Promise<{ error: null | unknown }>
  signUp: (email: string, password: string) => Promise<{ error: null | unknown }>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [supabaseToken, setSupabaseToken] = useState<string | null>(null)
  const [coreToken, setCoreToken] = useState<string | null>(null)
  const [tokenReady, setTokenReady] = useState(false)

  // Set up axios authorization with token
  const setupAxiosAuth = (token: string | null) => {
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`
    } else {
      delete axios.defaults.headers.common['Authorization']
    }
  }

  // Handle sign in with email and password
  const signIn = async (email: string, password: string) => {
    try {
      console.log('Signing in with email/password')
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      
      if (data.session?.access_token && !error) {
        console.log('Sign in successful, setting up tokens')
        setSupabaseToken(data.session.access_token)
        setSession(data.session)
        setUser(data.session.user)
        
        // Store email for admin checks
        if (data.session.user?.email) {
          localStorage.setItem('userEmail', data.session.user.email)
        }
        
        await exchangeForCoreToken(data.session.access_token)
        
        // Manual redirect to dashboard after successful sign in
        setTimeout(() => {
          console.log('Redirecting to account after successful sign in')
          window.location.href = `${window.location.origin}/account`
        }, 500)
      }
      
      return { error }
    } catch (error) {
      console.error('Error during sign in:', error)
      return { error }
    }
  }

  // Handle sign up with email and password
  const signUp = async (email: string, password: string) => {
    try {
      console.log('Signing up with email/password')
      const { data, error } = await supabase.auth.signUp({ 
        email, 
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/account`
        }
      })
      
      if (data.session?.access_token && !error) {
        console.log('Sign up successful, setting up tokens')
        setSupabaseToken(data.session.access_token)
        setSession(data.session)
        setUser(data.session.user)
        
        // Store email for admin checks
        if (data.session.user?.email) {
          localStorage.setItem('userEmail', data.session.user.email)
        }
        
        await exchangeForCoreToken(data.session.access_token)
        
        // Manual redirect to dashboard after successful sign up
        setTimeout(() => {
          // Redirecting to dashboard after successful sign up
          window.location.href = `${window.location.origin}/account`
        }, 500)
      } else if (!error) {
        // If no session but also no error, likely means email confirmation is required
        // Sign up successful, email confirmation may be required
      }
      
      return { error }
    } catch (error) {
      console.error('Error during sign up:', error)
      return { error }
    }
  }

  // Handle sign out
  const signOut = async () => {
    // Signing out user
    try {
      await supabase.auth.signOut()
      setupAxiosAuth(null)
      setSupabaseToken(null)
      setCoreToken(null)
      setUser(null)
      setSession(null)
      localStorage.removeItem('core_token')
      localStorage.removeItem('userEmail')
      // Sign out completed successfully
    } catch (error) {
      console.error('Error during sign out:', error)
    }
  }

  // Function to exchange Supabase token for Core token
  const exchangeForCoreToken = async (supabaseToken: string) => {
    try {
      setTokenReady(false) // Mark token as not ready during exchange
      
      const response = await axios.post(
        `${import.meta.env.VITE_CLOUD_API_URL || 'http://localhost:8002'}/api/auth/exchange-token`,
        { supabaseToken },
        { headers: { 'Content-Type': 'application/json' } }
      )
      
      if (response.status === 200 && response.data.coreToken) {
        // Successfully exchanged token for Core token
        setupAxiosAuth(response.data.coreToken)
        setCoreToken(response.data.coreToken)
        localStorage.setItem('core_token', response.data.coreToken)
        
        // Wait a short delay to ensure the token is available for subsequent API calls
        await new Promise(resolve => setTimeout(resolve, 300))
        setTokenReady(true) // Mark token as ready
        
        return response.data.coreToken
      } else {
        throw new Error(`Failed to exchange token: ${response.statusText}`)
      }
    } catch (error) {
      console.error('Failed to exchange token:', error)
      // Fall back to using Supabase token if exchange fails
      setupAxiosAuth(supabaseToken)
      setTokenReady(true) // Mark token as ready even with fallback
      return null
    }
  }

  useEffect(() => {
    // Get initial session from Supabase
    const initializeAuth = async () => {
      setLoading(true)
      setTokenReady(false)
      try {
        // Try to use existing core token first
        const savedCoreToken = localStorage.getItem('core_token')
        if (savedCoreToken) {
          // Using saved core token
          setupAxiosAuth(savedCoreToken)
          setCoreToken(savedCoreToken)
          // Small delay to ensure token is applied
          await new Promise(resolve => setTimeout(resolve, 100))
          setTokenReady(true)
        }
        
        // Get current session
        const { data } = await supabase.auth.getSession()
        setSession(data.session)
        setUser(data.session?.user || null)
        
        if (data.session?.access_token) {
          setSupabaseToken(data.session.access_token)
          
          // If no core token, try to exchange for one
          if (!savedCoreToken) {
            try {
              await exchangeForCoreToken(data.session.access_token)
            } catch (error) {
              console.error('Could not exchange token, using Supabase token as fallback')
              setupAxiosAuth(data.session.access_token)
              setTokenReady(true)
            }
          }
        } else {
          // No session, so we're as ready as we'll ever be
          setTokenReady(true)
        }
      } catch (error) {
        console.error('Error initializing auth:', error)
        setTokenReady(true) // Even on error, mark as ready to prevent UI hanging
      } finally {
        setLoading(false)
      }
    }

    initializeAuth()

    // Set up auth state change listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        // Auth state changed event
        setSession(session)
        setUser(session?.user || null)
        
        // Store user email in localStorage for admin checks
        if (session?.user?.email) {
          localStorage.setItem('userEmail', session.user.email)
        } else if (event === 'SIGNED_OUT') {
          localStorage.removeItem('userEmail')
        }

        if (event === 'SIGNED_IN' && session?.access_token) {
          // SIGNED_IN event detected
          setTokenReady(false) // Token exchange in progress
          setSupabaseToken(session.access_token)
          
          // Exchange for Core token on sign in
          try {
            await exchangeForCoreToken(session.access_token)
            // Auth completed
            
            // Handle redirection when auth is completed via JS flow
            // This helps cases where the Auth UI's redirectTo doesn't trigger
            if (window.location.pathname.includes('/signin') || 
                window.location.pathname.includes('/login') ||
                window.location.pathname.includes('/signup')) {
              // Redirecting to account
              window.location.href = `${window.location.origin}/account`
            }
          } catch (error) {
            console.error('Could not exchange token on sign-in, using Supabase token as fallback')
            setupAxiosAuth(session.access_token)
            setTokenReady(true)
          }
        } else if (event === 'SIGNED_OUT') {
          setupAxiosAuth(null)
          setSupabaseToken(null)
          setCoreToken(null)
          setTokenReady(false)
          localStorage.removeItem('core_token')
        } else {
          // For other events, ensure token is ready
          setTokenReady(true)
        }
      }
    )

    // Clean up subscription on unmount
    return () => {
      subscription.unsubscribe()
    }
  }, [])

  // Calculate authenticated state 
  const isAuthenticated = !!user && !!session

  return (
    <AuthContext.Provider value={{
      session,
      user,
      loading,
      isLoading: loading,
      isAuthenticated,
      supabaseToken,
      coreToken,
      tokenReady,
      signIn,
      signUp,
      signOut
    }}>
      {children}
    </AuthContext.Provider>
  )
}

// Remove duplicate useAuth - it's already defined in hooks/useAuth.tsx