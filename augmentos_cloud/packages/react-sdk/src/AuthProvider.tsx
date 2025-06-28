// react-sdk/src/AuthProvider.tsx
import React, { createContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { initializeAuth, clearStoredAuth, AuthState } from './lib/authCore';

export interface MentraAuthContextType extends AuthState {
  isLoading: boolean;
  error: string | null;
  logout: () => void;
  isAuthenticated: boolean;
}

export const MentraAuthContext = createContext<MentraAuthContextType | undefined>(undefined);

export const MentraAuthProvider = ({ children }: { children: ReactNode }) => {
  const [userId, setUserId] = useState<string | null>(null);
  const [frontendToken, setFrontendToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAuth = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const auth = await initializeAuth();
      setUserId(auth.userId);
      setFrontendToken(auth.frontendToken);
    } catch (e) {
      console.error("MentraOS Auth Initialization Error:", e);
      setError((e as Error).message || 'Unknown authentication error');
      clearStoredAuth(); // Clear any potentially bad stored state
      setUserId(null);
      setFrontendToken(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAuth();
  }, [loadAuth]);

  const logout = useCallback(() => {
    clearStoredAuth();
    setUserId(null);
    setFrontendToken(null);
  }, []);

  const isAuthenticated = !!userId && !!frontendToken;

  return (
    <MentraAuthContext.Provider value={{ userId, frontendToken, isLoading, error, logout, isAuthenticated }}>
      {children}
    </MentraAuthContext.Provider>
  );
};