/**
 * User Settings API
 *
 * Handles user settings like theme and chat history preferences.
 * The user id always comes from the authenticated context. Auth
 * is enforced at the sub-app level (see routes.ts), so handlers
 * read c.get("userId") directly.
 *
 * These routes work whether or not glasses are currently
 * connected, so they live on the auth-only sub-app rather than
 * the session sub-app.
 */

import type { AuthContext } from "../utils/auth";
import { UserSettings } from "../db/schemas/user-settings.schema";

/** GET /settings */
export async function getSettings(c: AuthContext) {
  const userId = c.get("userId");

  try {
    let settings = await UserSettings.findOne({ userId });

    if (!settings) {
      settings = await UserSettings.create({
        userId,
        theme: "dark",
        chatHistoryEnabled: false,
      });
    }

    return c.json(settings);
  } catch (error) {
    console.error("Error fetching settings:", error);
    return c.json({ error: "Failed to fetch settings" }, 500);
  }
}

/** PATCH /settings */
export async function updateSettings(c: AuthContext) {
  const userId = c.get("userId");

  try {
    const body = await c.req.json();
    // Strip any client-supplied userId. The authenticated id always wins.
    const { userId: _ignored, ...updates } = body;

    const settings = await UserSettings.findOneAndUpdate(
      { userId },
      { $set: updates },
      { returnDocument: "after", upsert: true },
    );

    return c.json(settings);
  } catch (error) {
    console.error("Error updating settings:", error);
    return c.json({ error: "Failed to update settings" }, 500);
  }
}
