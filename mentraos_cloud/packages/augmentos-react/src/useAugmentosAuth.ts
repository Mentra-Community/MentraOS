// augmentos-react/src/useAugmentosAuth.ts
import { useContext } from 'react';
import { AugmentosAuthContext, AugmentosAuthContextType } from './AuthProvider';

/**
 * Custom hook to access the Augmentos authentication context.
 *
 * @returns {AugmentosAuthContextType} The authentication context containing user state,
 * loading status, error information, and authentication methods.
 *
 * @throws {Error} When used outside of an AugmentosAuthProvider component.
 *
 * @example
 * ```tsx
 * const { userId, isAuthenticated, logout, isLoading } = useAugmentosAuth();
 * ```
 */
export const useAugmentosAuth = (): AugmentosAuthContextType => {
  const context = useContext(AugmentosAuthContext);
  if (context === undefined) {
    throw new Error('useAugmentosAuth must be used within an AugmentosAuthProvider');
  }
  return context;
};