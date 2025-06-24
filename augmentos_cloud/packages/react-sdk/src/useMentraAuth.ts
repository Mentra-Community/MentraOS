// augmentos-react/src/useMentraAuth.ts
import { useContext } from 'react';
import { MentraAuthContext, MentraAuthContextType } from './AuthProvider';

/**
 * Custom hook to access the Augmentos authentication context.
 *
 * @returns {MentraAuthContextType} The authentication context containing user state,
 * loading status, error information, and authentication methods.
 *
 * @throws {Error} When used outside of an MentraAuthProvider component.
 *
 * @example
 * ```tsx
 * const { userId, isAuthenticated, logout, isLoading } = useMentraAuth();
 * ```
 */
export const useMentraAuth = (): MentraAuthContextType => {
  const context = useContext(MentraAuthContext);
  if (context === undefined) {
    throw new Error('useMentraAuth must be used within an MentraAuthProvider');
  }
  return context;
};