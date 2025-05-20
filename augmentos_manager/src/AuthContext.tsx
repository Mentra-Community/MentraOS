import React, {createContext, useEffect, useState, useContext} from 'react';
import {supabase} from './supabaseClient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import coreCommunicator from './bridge/CoreCommunicator';
import {stopExternalService} from './bridge/CoreServiceStarter';

interface AuthContextProps {
  user: any; // or a more specific type from @supabase/supabase-js
  session: any;
  loading: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextProps>({
  user: null,
  session: null,
  loading: true,
  logout: () => {},
});

export const AuthProvider: React.FC<{children: React.ReactNode}> = ({
  children,
}) => {
  const [session, setSession] = useState<any>(null);
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 1. Check for an active session on mount
    const getInitialSession = async () => {
      const {
        data: {session},
      } = await supabase.auth.getSession();

      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    };

    getInitialSession();

    // 2. Listen for auth changes
    const {
      data: {subscription},
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Cleanup the listener
    return () => {
      subscription?.unsubscribe();
    };
  }, []);

  const logout = async () => {
    // Try to sign out with Supabase - may fail in offline mode
    await supabase.auth.signOut().catch(err => {
      console.log(
        'Supabase sign-out failed, continuing with local cleanup:',
        err,
      );
    });

    // Completely clear ALL Supabase Auth storage
    // This is critical to ensure user is redirected to login screen even when offline
    await AsyncStorage.removeItem('supabase.auth.token');
    await AsyncStorage.removeItem('supabase.auth.refreshToken');
    await AsyncStorage.removeItem('supabase.auth.session');
    await AsyncStorage.removeItem('supabase.auth.expires_at');
    await AsyncStorage.removeItem('supabase.auth.expires_in');
    await AsyncStorage.removeItem('supabase.auth.provider_token');
    await AsyncStorage.removeItem('supabase.auth.provider_refresh_token');

    // Clear any other user-related storage that might prevent proper logout
    const allKeys = await AsyncStorage.getAllKeys();
    const userKeys = allKeys.filter(
      (key: string) =>
        key.startsWith('supabase.auth.') ||
        key.includes('user') ||
        key.includes('token'),
    );

    if (userKeys.length > 0) {
      await AsyncStorage.multiRemove(userKeys);
    }

    // Clean up other services
    console.log('Cleaning up local sessions and services');

    // Delete core auth key
    await coreCommunicator.deleteAuthenticationSecretKey();

    // Stop the native services
    coreCommunicator.stopService();
    stopExternalService();

    // Clean up communicator resources
    coreCommunicator.cleanup();
    setSession(null);
    setUser(null);
  };

  const value: AuthContextProps = {
    user,
    session,
    loading,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth() {
  return useContext(AuthContext);
}
