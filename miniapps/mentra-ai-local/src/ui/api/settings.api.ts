/**
 * User settings API — local channel-RPC implementation.
 *
 * The cloud app hit `/api/settings` (GET/PATCH) over authenticated HTTP. The
 * local miniapp has no server, so these route to the background via the
 * `settings:*` channel RPC instead. The exported function names/signatures are
 * unchanged (the `frontendToken` arg is ignored) so the copied components
 * compile and call them exactly as before.
 */

import "../../shared/channels"
import type {Settings} from "../../shared/types"

export interface UserSettings {
  userId: string
  theme: "light" | "dark"
  chatHistoryEnabled: boolean
  createdAt?: string
  updatedAt?: string
}

function toUserSettings(s: Settings): UserSettings {
  return {userId: "local-user", theme: s.theme, chatHistoryEnabled: s.chatHistoryEnabled}
}

export const fetchUserSettings = async (_frontendToken?: string | null): Promise<UserSettings> => {
  const settings = await mentra.request("settings:get", undefined as never)
  return toUserSettings(settings)
}

export const updateUserSettings = async (
  _frontendToken: string | null,
  updates: Partial<Omit<UserSettings, "userId" | "createdAt" | "updatedAt">>,
): Promise<UserSettings> => {
  const settings = await mentra.request("settings:set", {
    ...(updates.theme !== undefined ? {theme: updates.theme} : {}),
    ...(updates.chatHistoryEnabled !== undefined
      ? {chatHistoryEnabled: updates.chatHistoryEnabled}
      : {}),
  })
  return toUserSettings(settings)
}

export const updateTheme = async (
  frontendToken: string | null,
  theme: "light" | "dark",
): Promise<UserSettings> => updateUserSettings(frontendToken, {theme})

export const updateChatHistoryEnabled = async (
  frontendToken: string | null,
  chatHistoryEnabled: boolean,
): Promise<UserSettings> => updateUserSettings(frontendToken, {chatHistoryEnabled})
