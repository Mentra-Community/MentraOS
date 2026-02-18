/**
 * CLI Credentials Manager
 *
 * Manages authentication credentials with multiple storage strategies:
 * 1. Primary: Bun.secrets (OS keychain - requires Bun 1.3+)
 * 2. Fallback: File-based storage (~/.mentra/credentials.json)
 * 3. CI/CD: Environment variable (MENTRA_CLI_TOKEN)
 */

import {homedir} from "os"
import {join} from "path"
import {readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync} from "fs"
import {CLICredentials} from "@mentra/types"
import jwt from "jsonwebtoken"

const MENTRA_DIR = join(homedir(), ".mentra")
const CREDS_FILE = join(MENTRA_DIR, "credentials.json")

/**
 * Save credentials using Bun.secrets (primary) with file fallback
 */
export async function saveCredentials(token: string): Promise<void> {
  // Decode token to extract info
  const decoded = jwt.decode(token) as any
  if (!decoded) throw new Error("Invalid token")

  const creds: CLICredentials = {
    token,
    email: decoded.email,
    keyName: decoded.name,
    keyId: decoded.keyId,
    storedAt: new Date().toISOString(),
    expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : undefined,
  }

  // Try Bun.secrets first (requires Bun 1.3+)
  try {
    if (typeof Bun !== "undefined" && typeof Bun.secrets !== "undefined") {
      await Bun.secrets.set({
        service: "mentra-cli",
        name: "credentials",
        value: JSON.stringify(creds),
      })
      console.log("✓ Credentials saved securely to OS keychain")
      return
    }
  } catch {
    console.warn("⚠️  OS keychain unavailable, using file-based storage")
  }

  // Fallback to file-based storage
  mkdirSync(MENTRA_DIR, {recursive: true})
  writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), {mode: 0o600})
  console.log("✓ Credentials saved to ~/.mentra/credentials.json")
}

/**
 * Load credentials from Bun.secrets or file fallback
 */
export async function loadCredentials(): Promise<CLICredentials | null> {
  // Try Bun.secrets first
  try {
    if (typeof Bun !== "undefined" && typeof Bun.secrets !== "undefined") {
      const value = await Bun.secrets.get({
        service: "mentra-cli",
        name: "credentials",
      })
      if (value) {
        return JSON.parse(value) as CLICredentials
      }
    }
  } catch {
    // Fall through to file
  }

  // Try file fallback
  try {
    if (existsSync(CREDS_FILE)) {
      const data = readFileSync(CREDS_FILE, "utf-8")
      return JSON.parse(data) as CLICredentials
    }
  } catch {
    // Fall through to env var
  }

  // Try environment variable (for CI/CD)
  if (process.env.MENTRA_CLI_TOKEN) {
    const token = process.env.MENTRA_CLI_TOKEN
    const decoded = jwt.decode(token) as any
    if (decoded) {
      return {
        token,
        email: decoded.email,
        keyName: decoded.name || "CI/CD",
        keyId: decoded.keyId,
        storedAt: new Date().toISOString(),
        expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : undefined,
      }
    }
  }

  return null
}

/**
 * Clear credentials from Bun.secrets and file
 */
export async function clearCredentials(): Promise<void> {
  // Try to remove from Bun.secrets
  try {
    if (typeof Bun !== "undefined" && typeof Bun.secrets !== "undefined") {
      // Bun.secrets doesn't have a delete method yet, so we set to empty
      await Bun.secrets.set({
        service: "mentra-cli",
        name: "credentials",
        value: "",
      })
    }
  } catch {
    // Ignore
  }

  // Remove file
  try {
    if (existsSync(CREDS_FILE)) {
      unlinkSync(CREDS_FILE)
    }
  } catch (err) {
    console.error("Failed to clear credentials:", err)
  }
}

/**
 * Require authentication or exit
 */
export async function requireAuth(): Promise<CLICredentials> {
  const creds = await loadCredentials()
  if (!creds) {
    console.error("✗ Not authenticated")
    console.error("  Run: mentra auth <token>")
    console.error("  Or set: MENTRA_CLI_TOKEN=<token>")
    process.exit(3)
  }

  // Check expiration
  if (creds.expiresAt && new Date(creds.expiresAt) < new Date()) {
    console.error("✗ CLI API key expired")
    console.error("  Generate a new key in the console")
    process.exit(3)
  }

  return creds
}
