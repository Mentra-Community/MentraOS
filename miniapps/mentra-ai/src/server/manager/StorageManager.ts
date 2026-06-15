import type { User } from "../session/User";

/**
 * StorageManager — read/write user preferences via MentraOS Simple Storage.
 */
export class StorageManager {
  constructor(private user: User) {}

  /** Get the user's theme preference, defaults to "light" */
  async getTheme(): Promise<"dark" | "light"> {
    const session = this.user.appSession;
    if (!session) return "light";

    try {
      const theme = await session.simpleStorage.get("theme");
      if (theme === "dark" || theme === "light") return theme;
      return "light";
    } catch {
      return "light";
    }
  }

  /** Save the user's theme preference */
  async setTheme(theme: "dark" | "light"): Promise<void> {
    const session = this.user.appSession;
    if (!session) throw new Error("No active glasses session");
    await session.simpleStorage.set("theme", theme);
  }
}
