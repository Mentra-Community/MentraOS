import type { AppSettings } from "../../types";
import { MentraSession } from "../MentraSession";

type SettingsChangeMap = Record<
  string,
  {
    oldValue: any;
    newValue: any;
  }
>;

export class _V2SettingsShim {
  private readonly session: MentraSession;

  constructor(session: MentraSession) {
    this.session = session;
  }

  has(key: string): boolean {
    return this.session.settingsData.some((setting) => setting.key === key);
  }

  getAll(): AppSettings {
    return [...this.session.settingsData];
  }

  get<T = any>(key: string, defaultValue?: T): T {
    const setting = this.session.settingsData.find((candidate) => candidate.key === key);
    if (setting && setting.value !== undefined) {
      return setting.value as T;
    }

    return defaultValue as T;
  }

  onChange(handler: (changes: SettingsChangeMap) => void): () => void {
    let previous = this.getAll();

    return this.session.onSettings((settings) => {
      const changes: SettingsChangeMap = {};

      for (const nextSetting of settings) {
        const oldSetting = previous.find((candidate) => candidate.key === nextSetting.key);
        if (oldSetting?.value !== nextSetting.value) {
          changes[nextSetting.key] = {
            oldValue: oldSetting?.value,
            newValue: nextSetting.value,
          };
        }
      }

      for (const oldSetting of previous) {
        if (!settings.some((candidate) => candidate.key === oldSetting.key)) {
          changes[oldSetting.key] = {
            oldValue: oldSetting.value,
            newValue: undefined,
          };
        }
      }

      previous = [...settings];

      if (Object.keys(changes).length > 0) {
        handler(changes);
      }
    });
  }

  onValueChange<T = any>(key: string, handler: (newValue: T, oldValue: T) => void): () => void {
    let previous = this.get<T>(key);

    return this.session.onSettings(() => {
      const next = this.get<T>(key);
      if (next !== previous) {
        const oldValue = previous;
        previous = next;
        handler(next, oldValue as T);
      }
    });
  }
}
