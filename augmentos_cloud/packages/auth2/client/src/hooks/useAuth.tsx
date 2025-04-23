// src/hooks/useAuth.tsx
import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';
import { Session, User } from '@supabase/supabase-js';
import axios from 'axios';
import { supabase } from '../utils/supabase';

// Set up auth token interceptor
const setAuthToken = (token: string | null) => {
  if (token) {
    axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  } else {
    delete axios.defaults.headers.common["Authorization"];
  }
};

// Define global window interface extensions
declare global {
  interface Window {
    setSupabaseToken: (token: string) => void;
    setCoreToken: (token: string) => void;
  }
}

// Define the types for our auth context
interface AuthContextType {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isWebViewAuth: boolean;
  supabaseToken: string | null;
  coreToken: string | null;
  signOut: () => Promise<void>;
}

// Create the auth context
const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Create the provider component
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isWebViewAuth, setIsWebViewAuth] = useState(false);
  const [supabaseToken, setSupabaseTokenState] = useState<string | null>(null);
  const [coreToken, setCoreTokenState] = useState<string | null>(null);

  // Set up axios authorization with token
  const setupAxiosAuth = (token: string | null) => {
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    } else {
      delete axios.defaults.headers.common['Authorization'];
    }
  };

  // Handle sign out
  const signOut = async () => {
    //await supabase.auth.signOut();
    setupAxiosAuth(null);
    setSupabaseTokenState(null);
    setCoreTokenState(null);
    localStorage.removeItem('supabase_token');
    localStorage.removeItem('core_token');
  };

  // Function to exchange Supabase token for Core token
  const exchangeForCoreToken = useCallback(async (supabaseToken: string) => {
    try {
      // Call the server endpoint instead of using authService directly
      const response = await axios.post('/exchange-token', { 
        supabaseToken 
      });
      
      if (response.data && response.data.coreToken) {
        const coreToken = response.data.coreToken;
        console.log('Successfully exchanged token for Core token');
        setupAxiosAuth(coreToken);
        setCoreTokenState(coreToken);
        localStorage.setItem('core_token', coreToken);
        return coreToken;
      } else {
        if (response.data && response.data.error) {
          throw new Error(`Failed to exchange token: ${response.data.error}`);
        } else {
          throw new Error('Failed to exchange token: Invalid response format');
        }
      }
    } catch (error) {
      console.error('Failed to exchange token:', error);
      // Fall back to using Supabase token if exchange fails
      setupAxiosAuth(supabaseToken);
      return null;
    }
  }, []);

  useEffect(() => {
    // Get initial session from Supabase
    const initializeAuth = async () => {
      setIsLoading(true);
      try {
        // Check for WebView injected tokens first
        const savedCoreToken = localStorage.getItem('core_token');
        const savedSupabaseToken = localStorage.getItem('supabase_token');
        
        if (savedCoreToken && savedSupabaseToken) {
          console.log('Using saved WebView tokens');
          setupAxiosAuth(savedCoreToken);
          setSupabaseTokenState(savedSupabaseToken);
          setCoreTokenState(savedCoreToken);
          // Create a minimal session object for our state
          setSession({ access_token: savedSupabaseToken } as Session);
          setUser({ id: 'webview-user' } as User);
          setIsWebViewAuth(true);
          setIsLoading(false);
          return;
        }
        
        // Fall back to Supabase auth
        const { data } = await supabase.auth.getSession();
        setSession(data.session);
        setUser(data.session?.user || null);
        
        if (data.session?.access_token) {
          // Store the Supabase token
          setSupabaseTokenState(data.session.access_token);
          
          // Exchange for Core token
          try {
            await exchangeForCoreToken(data.session.access_token);
          } catch (error: unknown) {
            console.error(`Could not exchange token due to ${error}, using Supabase token as fallback`);
            setupAxiosAuth(data.session.access_token);
          }
        }
      } catch (error) {
        console.error('Error initializing auth:', error);
      } finally {
        setIsLoading(false);
      }
    };

    initializeAuth();
    
    // Create global function for WebView token updates
    window.setSupabaseToken = (token: string) => {
      console.log('Supabase token received from WebView');
      setSupabaseTokenState(token);
      localStorage.setItem('supabase_token', token);
      
      // Try to exchange for CoreToken
      exchangeForCoreToken(token).then(coreToken => {
        // If we couldn't get a coreToken, use supabaseToken as fallback
        if (!coreToken) {
          setupAxiosAuth(token);
        }
        
        setSession({ access_token: token } as Session);
        setUser({ id: 'webview-user' } as User);
        setIsWebViewAuth(true);
      });
    };

    window.setCoreToken = (token: string) => {
      console.log('CoreToken received directly from WebView');
      setupAxiosAuth(token);
      setCoreTokenState(token);
      localStorage.setItem('core_token', token);
      
      // We still need a valid session for React state
      const supabaseToken = localStorage.getItem('supabase_token');
      if (supabaseToken) {
        setSession({ access_token: supabaseToken } as Session);
      } else {
        // Create a dummy session if no supabase token available
        setSession({ access_token: 'core-only-session' } as Session);
      }
      
      setUser({ id: 'webview-user' } as User);
      setIsWebViewAuth(true);
    };

    // Set up auth state change listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event: string, session: Session | null) => {
        console.log('Auth state changed:', event);
        setSession(session);
        setUser(session?.user || null);

        if (event === 'SIGNED_IN' && session?.access_token) {
          console.log('SIGNED_IN event detected, setting up authentication...');
          setSupabaseTokenState(session.access_token);
          
          // Exchange for Core token on sign in
          try {
            const newCoreToken = await exchangeForCoreToken(session.access_token);
            setAuthToken(newCoreToken);
            console.log('Auth completed, authenticated state:', !!session?.user);
            
            // Check if we're on the login page and need to redirect
            const isLoginPage = window.location.pathname.includes('/login') || 
                              window.location.pathname.includes('/signin');
            
            if (isLoginPage) {
              // Get redirect path from URL or storage
              const urlParams = new URLSearchParams(window.location.search);
              const redirectTo = urlParams.get('redirectTo') || localStorage.getItem('auth_redirect') || '/';
              
              console.log('Redirecting to:', redirectTo);
              // Clear storage
              localStorage.removeItem('auth_redirect');
              
              // Only redirect if we're on login page
              setTimeout(() => {
                window.location.href = window.location.origin + redirectTo;
              }, 300);
            }
          } catch (error: unknown) {
            console.error(`Could not exchange token on sign-in due to ${error}, using Supabase token as fallback`);
            setupAxiosAuth(session.access_token);
          }
        } else if (event === 'SIGNED_OUT') {
          setupAxiosAuth(null);
          setSupabaseTokenState(null);
          setCoreTokenState(null);
          localStorage.removeItem('supabase_token');
          localStorage.removeItem('core_token');
        }
      }
    );

    // Clean up subscription on unmount
    return () => {
      subscription.unsubscribe();
    };
  }, [exchangeForCoreToken]);

  // Calculate authenticated state
  const isAuthenticated = isWebViewAuth || (!!user && !!session);
  
  // Log authentication state changes for debugging
  useEffect(() => {
    console.log('Authentication state updated:', { 
      isAuthenticated, 
      hasUser: !!user, 
      hasSession: !!session,
      isWebViewAuth
    });
  }, [isAuthenticated, user, session, isWebViewAuth]);

  // Provide auth context to children components
  return (
    <AuthContext.Provider value={{
      session,
      user,
      isLoading,
      isAuthenticated,
      isWebViewAuth,
      supabaseToken,
      coreToken,
      signOut
    }}>
      {children}
    </AuthContext.Provider>
  );
}

// Custom hook to use the auth context
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}