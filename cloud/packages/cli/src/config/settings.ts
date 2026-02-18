/**
 * CLI Settings Manager
 *
 * Manages CLI configuration file (~/.mentra/config.json)
 */

import {homedir} from "os"
import {join} from "path"
import {readFileSync, writeFileSync, mkdirSync, existsSync} from "fs"

const MENTRA_DIR = join(homedir(), ".mentra")
const CONFIG_FILE = join(MENTRA_DIR, "config.json")

export interface Config {
  clouds?: {
    [key: string]: {
      name: string
      url: string
    }
  }
  currentCloud?: string
  output?: {
    format?: "table" | "json"
    colors?: boolean
  }
  default?: {
    org?: string
  }
}

/**
 * Get configuration
 */
export function getConfig(): Config {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return {}
    }
    const data = readFileSync(CONFIG_FILE, "utf-8")
    return JSON.parse(data) as Config
  } catch {
    return {}
  }
}

/**
 * Update configuration (merge with existing)
 */
export function updateConfig(updates: Partial<Config>): void {
  const config = getConfig()
  const updated = {...config, ...updates}

  mkdirSync(MENTRA_DIR, {recursive: true})
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), {mode: 0o600})
}

/**
 * Set a specific config value
 */
export function setConfigValue(key: string, value: any): void {
  const config = getConfig()
  const keys = key.split(".")

  let current: any = config
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) {
      current[keys[i]] = {}
    }
    current = current[keys[i]]
  }
  current[keys[keys.length - 1]] = value

  mkdirSync(MENTRA_DIR, {recursive: true})
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {mode: 0o600})
}

/**
 * Get a specific config value
 */
export function getConfigValue(key: string): any {
  const config = getConfig()
  const keys = key.split(".")

  let current: any = config
  for (const k of keys) {
    if (current === undefined || current === null) {
      return undefined
    }
    current = current[k]
  }
  return current
}
