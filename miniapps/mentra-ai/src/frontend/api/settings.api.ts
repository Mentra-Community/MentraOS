// API functions for user settings
// All requests authenticate via the MentraOS frontend token. The
// authenticated user id is derived server-side from c.get("authUserId").

import { createAuthFetch } from "../lib/authFetch";

const getApiUrl = () => window.location.origin;

export interface UserSettings {
  userId: string;
  theme: 'light' | 'dark';
  chatHistoryEnabled: boolean;
  /** Selected model key (see MODEL_OPTIONS on the server). */
  model?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Fetch user settings from the API
 */
export const fetchUserSettings = async (
  frontendToken: string | null,
): Promise<UserSettings> => {
  const apiUrl = getApiUrl();
  const authFetch = createAuthFetch(frontendToken);
  const response = await authFetch(`${apiUrl}/api/settings`);

  if (!response.ok) {
    throw new Error('Failed to fetch settings');
  }

  return response.json();
};

/**
 * Update user settings (partial update)
 */
export const updateUserSettings = async (
  frontendToken: string | null,
  updates: Partial<Omit<UserSettings, 'userId' | 'createdAt' | 'updatedAt'>>,
): Promise<UserSettings> => {
  const apiUrl = getApiUrl();
  const authFetch = createAuthFetch(frontendToken);
  const response = await authFetch(`${apiUrl}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    throw new Error('Failed to update settings');
  }

  return response.json();
};

/**
 * Update only the theme setting
 */
export const updateTheme = async (
  frontendToken: string | null,
  theme: 'light' | 'dark',
): Promise<UserSettings> => {
  return updateUserSettings(frontendToken, { theme });
};

/**
 * Update only the chatHistoryEnabled setting
 */
export const updateChatHistoryEnabled = async (
  frontendToken: string | null,
  chatHistoryEnabled: boolean,
): Promise<UserSettings> => {
  return updateUserSettings(frontendToken, { chatHistoryEnabled });
};
