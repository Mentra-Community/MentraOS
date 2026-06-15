import type { SessionContext } from "../utils/auth";

/** GET /theme-preference */
export async function getThemePreference(c: SessionContext) {
  const user = c.get("user");

  if (!user.appSession) {
    return c.json({ error: "No active session" }, 404);
  }

  try {
    const theme = await user.storage.getTheme();
    return c.json({ theme });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
}

/** POST /theme-preference */
export async function setThemePreference(c: SessionContext) {
  const user = c.get("user");

  const { theme } = await c.req.json();
  if (!theme || (theme !== "dark" && theme !== "light")) {
    return c.json({ error: 'theme must be "dark" or "light"' }, 400);
  }

  if (!user.appSession) {
    return c.json({ error: "No active session" }, 404);
  }

  try {
    await user.storage.setTheme(theme);
    return c.json({ success: true, theme });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
}
