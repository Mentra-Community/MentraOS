// src/hooks/useAuth.tsx
import { useState, useEffect, createContext, useContext, useRef, useMemo } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../utils/supabase';
import axios from 'axios';

// Declare window type
declare global {
  interface Window {
    location: Location;
  }
}

// Define the types for our auth context
interface AuthContextType {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  supabaseToken: string | null;
  coreToken: string | null;
  tokenReady: boolean;
  signIn: (email: string, password: string) => Promise<{ error: null | unknown }>;
  signUp: (email: string, password: string) => Promise<{ error: null | unknown }>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

// Create the auth context
const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Create the provider component
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [supabaseToken, setSupabaseToken] = useState<string | null>(null);
  const [coreToken, setCoreToken] = useState<string | null>(null);
  const [tokenReady, setTokenReady] = useState(false);

  // Use refs to track previous values for comparison
  const prevUserIdRef = useRef<string | undefined>(undefined);
  const prevTokenRef = useRef<string | null>(null);

  // Set up axios authorization with token
  const setupAxiosAuth = (token: string | null) => {
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    } else {
      delete axios.defaults.headers.common['Authorization'];
    }
  };

  // Handle sign in with email and password
  const signIn = async (email: string, password: string) => {
    try {
      console.log('Signing in with email/password');
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });

      if (data.session?.access_token && !error) {
        console.log('Sign in successful, setting up tokens');
        setSupabaseToken(data.session.access_token);
        setSession(data.session);
        setUser(data.session.user);

        // Store email for admin checks
        if (data.session.user?.email) {
          localStorage.setItem('userEmail', data.session.user.email);
        }

        await exchangeForCoreToken(data.session.access_token);

        // Manual redirect to dashboard after successful sign in, unless handling invite token
        const hasInviteToken = new URLSearchParams(window.location.search).has('token');
        if (!hasInviteToken) {
          setTimeout(() => {
            console.log('Redirecting to dashboard after successful sign in');
            window.location.href = `${window.location.origin}/dashboard`;
          }, 500);
        }
      }

      return { error };
    } catch (error) {
      console.error('Error during sign in:', error);
      return { error };
    }
  };

  // Function to refresh user data
  const refreshUser = async (): Promise<void> => {
    try {
      // Get current session and user data
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      setUser(data.session?.user || null);

      // Get user data from API
      if (data.session?.access_token) {
        try {
          const response = await axios.get('/api/dev/auth/me');
          // Update user email if it changed
          if (response.data.email && data.session?.user?.email !== response.data.email) {
            console.log('User data refreshed from API');
          }
        } catch (error) {
          console.error('Error fetching user data from API:', error);
        }
      }
    } catch (error) {
      console.error('Error refreshing user:', error);
    }
  };

  // Handle sign up with email and password
  const signUp = async (email: string, password: string) => {
    try {
      console.log('Signing up with email/password');
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/dashboard`
        }
      });

      if (data.session?.access_token && !error) {
        console.log('Sign up successful, setting up tokens');
        setSupabaseToken(data.session.access_token);
        setSession(data.session);
        setUser(data.session.user);

        // Store email for admin checks
        if (data.session.user?.email) {
          localStorage.setItem('userEmail', data.session.user.email);
        }

        await exchangeForCoreToken(data.session.access_token);

        // Manual redirect to dashboard after successful sign up, unless handling invite token
        const hasInviteToken = new URLSearchParams(window.location.search).has('token');
        if (!hasInviteToken) {
          setTimeout(() => {
            // Redirecting to dashboard after successful sign up;
            window.location.href = `${window.location.origin}/dashboard`;
          }, 500);
        }
      } else if (!error) {
        // If no session but also no error, likely means email confirmation is required
        // Sign up successful, email confirmation may be required;
      }

      return { error };
    } catch (error) {
      console.error('Error during sign up:', error);
      return { error };
    }
  };

  // Handle sign out
  const signOut = async () => {
    // Signing out user;
    try {
      await supabase.auth.signOut();
      setupAxiosAuth(null);
      setSupabaseToken(null);
      setCoreToken(null);
      setUser(null);
      setSession(null);
      localStorage.removeItem('core_token');
      localStorage.removeItem('userEmail');
      // Sign out completed successfully;
    } catch (error) {
      console.error('Error during sign out:', error);
    }
  };

  // Function to exchange Supabase token for Core token
  const exchangeForCoreToken = async (supabaseToken: string) => {
    try {
      setTokenReady(false); // Mark token as not ready during exchange

      const response = await axios.post(
        `${import.meta.env.VITE_API_URL || 'http://localhost:8002'}/api/auth/exchange-token`,
        { supabaseToken },
        { headers: { 'Content-Type': 'application/json' } }
      );

      if (response.status === 200 && response.data.coreToken) {
        // Successfully exchanged token for Core token;
        setupAxiosAuth(response.data.coreToken);
        setCoreToken(response.data.coreToken);
        localStorage.setItem('core_token', response.data.coreToken);

        // Wait a short delay to ensure the token is available for subsequent API calls
        await new Promise(resolve => setTimeout(resolve, 300));
        setTokenReady(true); // Mark token as ready

        return response.data.coreToken;
      } else {
        throw new Error(`Failed to exchange token: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to exchange token:', error);
      // Fall back to using Supabase token if exchange fails
      setupAxiosAuth(supabaseToken);
      setTokenReady(true); // Mark token as ready even with fallback
      return null;
    }
  };

  useEffect(() => {
    // Get initial session from Supabase
    const initializeAuth = async () => {
      setIsLoading(true);
      setTokenReady(false);
      try {
        // Try to use existing core token first
        const savedCoreToken = localStorage.getItem('core_token');
        if (savedCoreToken) {
          // Using saved core token;
          setupAxiosAuth(savedCoreToken);
          setCoreToken(savedCoreToken);
          // Small delay to ensure token is applied
          await new Promise(resolve => setTimeout(resolve, 100));
          setTokenReady(true);
        }

        // Get current session
        const { data } = await supabase.auth.getSession();
        setSession(data.session);
        setUser(data.session?.user || null);

        if (data.session?.access_token) {
          setSupabaseToken(data.session.access_token);

          // If no core token, try to exchange for one
          if (!savedCoreToken) {
            try {
              await exchangeForCoreToken(data.session.access_token);
            } catch (error) {
              console.error('Could not exchange token, using Supabase token as fallback');
              setupAxiosAuth(data.session.access_token);
              setTokenReady(true);
            }
          }
        } else {
          // No session, so we're as ready as we'll ever be
          setTokenReady(true);
        }
      } catch (error) {
        console.error('Error initializing auth:', error);
        setTokenReady(true); // Even on error, mark as ready to prevent UI hanging
      } finally {
        setIsLoading(false);
      }
    };

    initializeAuth();

        // Set up auth state change listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        // Skip token refresh events and focus/blur events that don't change the session
        const currentUserId = user?.id;
        const newUserId = session?.user?.id;
        const currentToken = supabaseToken;
        const newToken = session?.access_token;

        // Check if this is a meaningful change
        const isUserChanged = currentUserId !== newUserId;
        const isTokenChanged = currentToken !== newToken;
        const isSignOut = event === 'SIGNED_OUT';
        const isSignIn = event === 'SIGNED_IN' && !currentUserId && newUserId;

        // Skip updates if nothing meaningful changed
        if (!isUserChanged && !isTokenChanged && !isSignOut && !isSignIn) {
          return;
        }

        // Update refs with new values
        if (newUserId) prevUserIdRef.current = newUserId;
        if (newToken) prevTokenRef.current = newToken;

        // Auth state changed event;
        setSession(session);
        setUser(session?.user || null);

        // Store user email in localStorage for admin checks
        if (session?.user?.email) {
          localStorage.setItem('userEmail', session.user.email);
        } else if (event === 'SIGNED_OUT') {
          localStorage.removeItem('userEmail');
        }

        if (event === 'SIGNED_IN' && session?.access_token) {
          // SIGNED_IN event detected;
          setTokenReady(false); // Token exchange in progress
          setSupabaseToken(session.access_token);

          // Exchange for Core token on sign in
          try {
            await exchangeForCoreToken(session.access_token);
            // Auth completed;

            // Handle redirection when auth is completed via JS flow
            // This helps cases where the Auth UI's redirectTo doesn't trigger
            const hasInviteToken = new URLSearchParams(window.location.search).has('token');
            if (!hasInviteToken && (window.location.pathname.includes('/signin') ||
                window.location.pathname.includes('/login') ||
                window.location.pathname.includes('/signup'))) {
              // Redirecting to dashboard;
              window.location.href = `${window.location.origin}/dashboard`;
            }
          } catch (error) {
            console.error('Could not exchange token on sign-in, using Supabase token as fallback');
            setupAxiosAuth(session.access_token);
            setTokenReady(true);
          }
        } else if (event === 'SIGNED_OUT') {
          setupAxiosAuth(null);
          setSupabaseToken(null);
          setCoreToken(null);
          setTokenReady(false);
          localStorage.removeItem('core_token');
                } else if (event === 'USER_UPDATED' && session?.access_token && isTokenChanged) {
          // Only exchange token if it actually changed
          setTokenReady(false);
          setSupabaseToken(session.access_token);
          try {
            await exchangeForCoreToken(session.access_token);
          } catch (error) {
            console.error('Could not exchange token on user update');
            setupAxiosAuth(session.access_token);
            setTokenReady(true);
          }
        }
      }
    );

    // Clean up subscription on unmount
    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Calculate authenticated state
  const isAuthenticated = !!user && !!session;

  // Only log significant auth state changes in development
  useEffect(() => {
    if (process.env.NODE_ENV === 'development' && isAuthenticated) {
      // Only log once when fully authenticated
      if (!!user && !!session) {
        console.log('User authenticated');
      }
    }
  }, [isAuthenticated, user?.id, session?.access_token]);

  // Memoize the context value to prevent unnecessary re-renders
  const contextValue = useMemo(() => ({
    session,
    user,
    isLoading,
    isAuthenticated,
    supabaseToken,
    coreToken,
    tokenReady,
    signIn,
    signUp,
    signOut,
    refreshUser
  }), [session, user, isLoading, isAuthenticated, supabaseToken, coreToken, tokenReady]);

  // Provide auth context to children components
  return (
    <AuthContext.Provider value={contextValue}>
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