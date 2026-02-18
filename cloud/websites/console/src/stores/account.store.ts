/**
 * account.store.ts
 *
 * Placeholder Zustand store for Console account/auth state.
 * This provides a minimal structure and TODOs to finalize during API migration.
 *
 * Responsibilities:
 * - Hold session user info (email) and simple auth flags (signedIn, loading, error).
 * - Provide actions to set the Authorization token header, fetch the signed-in user, and sign out.
 *
 * Notes:
 * - The Cloud backend is responsible for ensuring a default org exists at auth and/or org-required actions.
 * - This store should NOT create organizations. It only reflects account state on the client.
 * - While migrating to /api/console, prefer GET /api/console/account; keep a legacy fallback if needed.
 */

import axios from "axios";
import { create } from "zustand";
import api from "@/services/api.service";

export type AccountState = {
  email: string | null;
  signedIn: boolean;
  loading: boolean;
  error: string | null;
};

export type AccountActions = {
  /**
   * Set or clear the Authorization header for subsequent API requests.
   * Pass a JWT ("core token"). When null, clears the header.
   */
  setToken: (token: string | null) => void;

  /**
   * Fetch the currently authenticated user.
   * TODO: Confirm final endpoint under /api/console/account and remove legacy fallback.
   */
  fetchAccount: () => Promise<void>;
  fetchMe: () => Promise<void>;

  /**
   * Clear in-memory account state and remove Authorization header.
   * TODO: If you persist tokens outside this store (e.g., cookies or another store), clear them there as well.
   */
  signOut: () => void;

  /**
   * Internal util to set an error (optional external usage).
   */
  setError: (message: string | null) => void;
};

export type AccountStore = AccountState & AccountActions;

export const useAccountStore = create<AccountStore>((set, get) => ({
  // State
  email: null,
  signedIn: false,
  loading: false,
  error: null,

  // Actions
  setToken: (token: string | null) => {
    // TODO: If the token is also persisted in another place, sync that here.
    if (token) {
      axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    } else {
      delete axios.defaults.headers.common["Authorization"];
    }
  },

  fetchMe: async () => {
    set({ loading: true, error: null });
    try {
      // Prefer new console endpoint
      const account = await api.console.account.get();
      const email = account?.email ?? null;

      set({
        email,
        signedIn: Boolean(email),
        loading: false,
        error: null,
      });
    } catch (err) {
      // Fallback to legacy auth if console account endpoint is not available
      console.error("Failed to fetch account", err);
      try {
        const me = await api.auth.me();
        const email = me?.email ?? null;

        set({
          email,
          signedIn: Boolean(email),
          loading: false,
          error: null,
        });
      } catch (fallbackErr) {
        const message =
          fallbackErr instanceof Error
            ? fallbackErr.message
            : "Failed to fetch account";
        set({
          loading: false,
          signedIn: false,
          email: null,
          error: message,
        });
      }
    }
  },

  fetchAccount: async () => {
    await get().fetchMe();
  },

  signOut: () => {
    // Clear in-memory state
    set({
      email: null,
      signedIn: false,
      loading: false,
      error: null,
    });

    // Clear Authorization header
    delete axios.defaults.headers.common["Authorization"];

    // TODO:
    // - If tokens/cookies are managed elsewhere, clear them there as well.
    // - Consider redirect or UI flow after sign-out.
  },

  setError: (message: string | null) => set({ error: message }),
}));

/**
 * Selectors (example usage):
 * const email = useAccountStore(s => s.email)
 * const loading = useAccountStore(s => s.loading)
 * const signedIn = useAccountStore(s => s.signedIn)
 *
 * Initialization (example):
 * - Call useAccountStore.getState().setToken(token) after login.
 * - Then await useAccountStore.getState().fetchAccount() to populate account state.
 */
