/**
 * Cloud Management
 *
 * Manages Mentra cloud environments (production, staging, development, custom)
 */

import {readFileSync} from "fs"
import {join, dirname} from "path"
import {fileURLToPath} from "url"
import yaml from "yaml"
import {getConfig, updateConfig} from "./settings"
import {Cloud} from "@mentra/types"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface Clouds {
  [key: string]: Cloud
}

/**
 * Load built-in clouds from YAML
 */
function getBuiltinClouds(): Clouds {
  const yamlPath = join(__dirname, "clouds.yaml")
  const yamlContent = readFileSync(yamlPath, "utf-8")
  const clouds = yaml.parse(yamlContent) as Clouds

  // Mark as built-in
  Object.values(clouds).forEach((cloud) => (cloud.builtin = true))

  return clouds
}

/**
 * Get all clouds (built-in + custom)
 */
export function getAllClouds(): Clouds {
  const builtins = getBuiltinClouds()
  const config = getConfig()
  const custom = config.clouds || {}

  return {...builtins, ...custom}
}

/**
 * Get current cloud
 */
export function getCurrentCloud(): {key: string; cloud: Cloud} {
  const config = getConfig()
  const cloudKey = config.currentCloud || "production"
  const allClouds = getAllClouds()
  const cloud = allClouds[cloudKey]

  if (!cloud) {
    throw new Error(`Cloud '${cloudKey}' not found`)
  }

  return {key: cloudKey, cloud}
}

/**
 * Get API URL for current cloud
 * Priority: MENTRA_API_URL env var > current cloud > production
 */
export function getApiUrl(): string {
  // Environment variable takes precedence
  if (process.env.MENTRA_API_URL) {
    return process.env.MENTRA_API_URL
  }

  const {cloud} = getCurrentCloud()
  return cloud.url
}

/**
 * Switch cloud
 */
export function switchCloud(cloudKey: string): void {
  const allClouds = getAllClouds()

  if (!allClouds[cloudKey]) {
    throw new Error(`Cloud '${cloudKey}' not found`)
  }

  updateConfig({currentCloud: cloudKey})
}

/**
 * Add custom cloud
 */
export function addCloud(key: string, cloud: {name: string; url: string}): void {
  if (!key.match(/^[a-z0-9-]+$/)) {
    throw new Error("Cloud key must be lowercase alphanumeric with hyphens")
  }

  const builtins = getBuiltinClouds()
  if (builtins[key]) {
    throw new Error(`Cannot override built-in cloud '${key}'`)
  }

  const config = getConfig()
  const clouds = config.clouds || {}

  clouds[key] = cloud
  updateConfig({clouds})
}

/**
 * Remove custom cloud
 */
export function removeCloud(cloudKey: string): void {
  const builtins = getBuiltinClouds()
  if (builtins[cloudKey]) {
    throw new Error(`Cannot remove built-in cloud '${cloudKey}'`)
  }

  const config = getConfig()
  const clouds = config.clouds || {}

  if (!clouds[cloudKey]) {
    throw new Error(`Cloud '${cloudKey}' not found`)
  }

  delete clouds[cloudKey]
  updateConfig({clouds})

  // If we removed the current cloud, switch to production
  if (config.currentCloud === cloudKey) {
    updateConfig({currentCloud: "production"})
  }
}

/**
 * Update cloud URL
 */
export function updateCloud(cloudKey: string, updates: Partial<{name: string; url: string}>): void {
  const builtins = getBuiltinClouds()
  if (builtins[cloudKey]) {
    throw new Error(`Cannot update built-in cloud '${cloudKey}'`)
  }

  const config = getConfig()
  const clouds = config.clouds || {}

  if (!clouds[cloudKey]) {
    throw new Error(`Cloud '${cloudKey}' not found`)
  }

  clouds[cloudKey] = {...clouds[cloudKey], ...updates}
  updateConfig({clouds})
}
