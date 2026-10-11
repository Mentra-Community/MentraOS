import type { AccountAuthClient } from "./supabase";

const STORAGE_KEY = "mentra-account:password-recovery";

type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Tracks whether this tab arrived from a password recovery link.
 *
 * supabase-js emits `PASSWORD_RECOVERY` once, right after it exchanges the
 * code from the email link, so the listener is attached when the client is
 * created. The flag is kept in session storage so a reload of /reset still
 * shows the "Set a new password" form while the recovery session lasts.
 */
export interface RecoveryState {
  isActive(): boolean;
  subscribe(listener: () => void): () => void;
  clear(): void;
}

export function createRecoveryState(
  auth: AccountAuthClient,
  storage: FlagStorage | null | undefined,
): RecoveryState {
  const listeners = new Set<() => void>();
  let active = readFlag(storage);

  const set = (next: boolean) => {
    if (next === active) return;
    active = next;
    writeFlag(storage, next);
    for (const listener of listeners) listener();
  };

  auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") set(true);
    else if (event === "SIGNED_OUT") set(false);
  });

  return {
    isActive: () => active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear: () => set(false),
  };
}

function readFlag(storage: FlagStorage | null | undefined): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFlag(storage: FlagStorage | null | undefined, value: boolean): void {
  try {
    if (value) storage?.setItem(STORAGE_KEY, "1");
    else storage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private browsing); the in-memory flag still works.
  }
}
