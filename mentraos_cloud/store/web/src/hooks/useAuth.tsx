// src/hooks/useAuth.tsx
import { useState, useEffect, createContext, useContext } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../utils/supabase';
import axios from 'axios';
import { setAuthToken } from '../api';

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

// Package name for the store to be used in token exchange
const STORE_PACKAGE_NAME = 'org.augmentos.store';

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
    await supabase.auth.signOut();
    setupAxiosAuth(null);
    setSupabaseTokenState(null);
    setCoreTokenState(null);
    localStorage.removeItem('supabase_token');
    localStorage.removeItem('core_token');
  };

  // Function to exchange Supabase token for Core token
  const exchangeForCoreToken = async (supabaseToken: string) => {
    try {
      // Import the API module
      const api = (await import('../api')).default;
      const coreToken = await api.auth.exchangeToken(supabaseToken);
      
      console.log('Successfully exchanged token for Core token');
      setupAxiosAuth(coreToken);
      setCoreTokenState(coreToken);
      localStorage.setItem('core_token', coreToken);
      return coreToken;
    } catch (error) {
      console.error('Failed to exchange token:', error);
      // Fall back to using Supabase token if exchange fails
      setupAxiosAuth(supabaseToken);
      return null;
    }
  };

  // Extract temporary token from URL
  const extractTempTokenFromUrl = (url: string): string | null => {
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.searchParams.get('aos_temp_token');
    } catch (e) {
      console.error("Error parsing URL for temp token:", e);
      return null;
    }
  };

  // Exchange temporary token for user tokens
  const exchangeTempToken = async (tempToken: string): Promise<boolean> => {
    try {
      // Import the API module
      const api = (await import('../api')).default;
      
      // Add the method to the API module at runtime if needed
      if (api.auth.exchangeTemporaryToken === undefined) {
        console.error('exchangeTemporaryToken method not found in API');
        return false;
      }
      
      const result = await api.auth.exchangeTemporaryToken(tempToken, STORE_PACKAGE_NAME);
      
      if (result.success && result.tokens) {
        console.log('Successfully exchanged temporary token');
        
        // Set up auth with the tokens
        if (result.tokens.coreToken) {
          setupAxiosAuth(result.tokens.coreToken);
          setCoreTokenState(result.tokens.coreToken);
          localStorage.setItem('core_token', result.tokens.coreToken);
        }
        
        if (result.tokens.supabaseToken) {
          setSupabaseTokenState(result.tokens.supabaseToken);
          localStorage.setItem('supabase_token', result.tokens.supabaseToken);
        }
        
        // Set up session and user
        setSession({ access_token: result.tokens.supabaseToken || 'temp-token-session' } as Session);
        setUser({ id: result.userId || 'webview-user' } as User);
        setIsWebViewAuth(true);
        
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to exchange temporary token:', error);
      return false;
    }
  };

  useEffect(() => {
    // Get initial session from Supabase
    const initializeAuth = async () => {
      setIsLoading(true);
      try {
        // Check for temporary token in URL
        const tempToken = extractTempTokenFromUrl(window.location.href);
        if (tempToken) {
          console.log('Temporary token found in URL');
          const success = await exchangeTempToken(tempToken);
          if (success) {
            console.log('Successfully authenticated using temporary token');
            setIsLoading(false);
            return;
          }
          console.error('Failed to exchange temporary token');
        }
        
        // Check for WebView injected tokens in localStorage as fallback
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
          } catch (error) {
            console.error('Could not exchange token, using Supabase token as fallback');
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
      async (event, session) => {
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
            const localRedirect = localStorage.getItem('auth_redirect');
            const urlParams = new URLSearchParams(window.location.search);
            const redirectToFromURLParams = urlParams.get('redirectTo');
            if (isLoginPage || localRedirect || redirectToFromURLParams) {
              console.log(`isLoginPage: ${isLoginPage}`);
              console.log(`localRedirect: ${localRedirect}`);
              console.log(`redirectToFromURLParams: ${redirectToFromURLParams}`);
              const redirectTo = redirectToFromURLParams || localRedirect || '/';
              console.log('Redirecting to:', redirectTo);
              // Clear storage
              localStorage.removeItem('auth_redirect');
              
              // Only redirect if we're on login page
              setTimeout(() => {
                window.location.href = window.location.origin + redirectTo;
              }, 300);
            }
          } catch (error) {
            console.error('Could not exchange token on sign-in, using Supabase token as fallback');
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
  }, []);

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