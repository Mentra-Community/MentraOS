# MentraOS CLI Architecture

Technical implementation plan for CLI tool.

## Naming Conventions

- **Package:** `@mentra/cli` (npm)
- **Binary:** `mentra` (command)
- **Config directory:** `~/.mentra/` (not `~/.mentraos/`)
- **Credentials:** OS keychain via `Bun.secrets` (service: `mentra-cli`)
- **Per-project config:** `.mentrarc` (not `.mentraosrc`)
- **Environment variables:** `MENTRA_CLI_TOKEN`, `MENTRA_API_URL`

## Core Design Pattern: Middleware at Mount Point

**Key Principle:** Routes are auth-agnostic; authentication is applied at mount time.

Console routes (e.g., `console.apps.api.ts`) define endpoints **without** middleware in route definitions. Auth middleware is applied when mounting the router, allowing the same routes to work with different auth contexts (console JWT vs CLI JWT).

```typescript
// Route definition (NO middleware)
const router = Router()
router.get("/", listApps)
router.post("/", createApp)

// Mounting with auth
app.use("/api/console/apps", authenticateConsole, consoleAppsRouter) // Console
app.use("/api/cli/apps", authenticateCLI, transformToConsole, consoleAppsRouter) // CLI
```

This enables:

- Same handlers for console UI and CLI tool
- Auth context transformation (`req.cli` → `req.console`)
- No code duplication
- Clean separation of concerns

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       Developer Machine                      │
│                                                              │
│  ┌────────────────┐         ┌─────────────────────────┐    │
│  │   CLI Tool     │────────▶│ ~/.mentraos/            │    │
│  │   (Bun)        │         │   credentials.json      │    │
│  │                │         │   config.json           │    │
│  └────────┬───────┘         └─────────────────────────┘    │
│           │                                                  │
│           │ HTTPS + Bearer Token                            │
└───────────┼──────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│                      MentraOS Cloud                          │
│                                                              │
│  ┌─────────────────┐      ┌──────────────────────────┐     │
│  │ /api/cli/*      │─────▶│ authenticateCLI          │     │
│  │ (CLI routes)    │      │ (middleware)             │     │
│  └────────┬────────┘      └──────────┬───────────────┘     │
│           │                          │                      │
│           │                          ▼                      │
│           │                  ┌───────────────┐             │
│           │                  │ CLIKey.find() │             │
│           │                  │ validate()    │             │
│           │                  └───────────────┘             │
│           │                          │                      │
│           │                          ▼                      │
│           │                  req.cli = {                    │
│           │                    email, keyId               │
│           │                  }                              │
│           │                          │                      │
│           ▼                          ▼                      │
│  ┌────────────────────────────────────────┐               │
│  │ Transform: req.cli → req.console       │               │
│  └────────┬───────────────────────────────┘               │
│           │                                                 │
│           ▼                                                 │
│  ┌─────────────────────────────────────┐                  │
│  │ Reuse Console Handlers              │                  │
│  │   - console.apps.service.ts         │                  │
│  │   - orgs.service.ts                 │                  │
│  └─────────────────────────────────────┘                  │
│                                                              │
│  ┌─────────────────────────────────────┐                  │
│  │ /api/console/cli-keys               │                  │
│  │ (Key management - console auth)     │                  │
│  └─────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────┘
```

## Database Model

### CLIKey Collection

**File:** `cloud/packages/cloud/src/models/cli-key.model.ts`

```typescript
import mongoose, {Schema, Document, Types} from "mongoose"

export interface CLIKeyI extends Document {
  keyId: string // UUID v4
  userId: Types.ObjectId // User ref
  email: string // Denormalized
  name: string // "My Laptop"
  hashedToken: string // SHA-256(JWT)
  createdAt: Date
  updatedAt: Date
  lastUsedAt?: Date
  expiresAt?: Date
  isActive: boolean
  metadata?: {
    createdFrom?: string
    userAgent?: string
  }
}

const CLIKeySchema = new Schema<CLIKeyI>(
  {
    keyId: {type: String, required: true, unique: true, index: true},
    userId: {type: Schema.Types.ObjectId, ref: "User", required: true, index: true},
    email: {type: String, required: true, lowercase: true, trim: true, index: true},
    name: {type: String, required: true, trim: true, maxlength: 100},
    hashedToken: {type: String, required: true, unique: true, index: true},
    lastUsedAt: {type: Date},
    expiresAt: {type: Date, index: true},
    isActive: {type: Boolean, required: true, default: true, index: true},
    metadata: {
      createdFrom: String,
      userAgent: String,
    },
  },
  {timestamps: true},
)

// Compound indexes
CLIKeySchema.index({userId: 1, isActive: 1})
CLIKeySchema.index({email: 1, isActive: 1})
CLIKeySchema.index({userId: 1, createdAt: -1})
CLIKeySchema.index({expiresAt: 1, isActive: 1})

// Static methods
CLIKeySchema.statics.findActiveByUserId = async function (userId: Types.ObjectId) {
  return this.find({userId, isActive: true}).sort({createdAt: -1})
}

CLIKeySchema.statics.findActiveByKeyId = async function (keyId: string) {
  return this.findOne({keyId, isActive: true})
}

CLIKeySchema.statics.revokeByUserId = async function (keyId: string, userId: Types.ObjectId) {
  const result = await this.updateOne({keyId, userId, isActive: true}, {$set: {isActive: false, updatedAt: new Date()}})
  return result.modifiedCount > 0
}

CLIKeySchema.statics.trackUsage = async function (keyId: string) {
  await this.updateOne({keyId}, {$set: {lastUsedAt: new Date()}})
}

CLIKeySchema.statics.cleanupExpired = async function () {
  const result = await this.updateMany({expiresAt: {$lt: new Date()}, isActive: true}, {$set: {isActive: false}})
  return result.modifiedCount
}

// Instance methods
CLIKeySchema.methods.isValid = function () {
  if (!this.isActive) return false
  if (this.expiresAt && this.expiresAt < new Date()) return false
  return true
}

export const CLIKey = mongoose.models.CLIKey || mongoose.model<CLIKeyI>("CLIKey", CLIKeySchema)
```

## Backend Implementation

### 1. Types Package

**File:** `cloud/packages/types/src/cli.ts`

```typescript
export interface CLIApiKey {
  keyId: string
  userId: string
  email: string
  name: string
  hashedToken: string
  createdAt: Date
  updatedAt: Date
  lastUsedAt?: Date
  expiresAt?: Date
  isActive: boolean
  metadata?: {
    createdFrom?: string
    userAgent?: string
  }
}

export interface GenerateCLIKeyRequest {
  name: string
  expiresInDays?: number
}

export interface GenerateCLIKeyResponse {
  keyId: string
  name: string
  token: string // Shown ONCE
  createdAt: string
  expiresAt?: string
}

export interface CLIApiKeyListItem {
  keyId: string
  name: string
  createdAt: string
  lastUsedAt?: string
  expiresAt?: string
  isActive: boolean
}

export interface UpdateCLIKeyRequest {
  name: string
}

export interface CLITokenPayload {
  email: string
  type: "cli"
  keyId: string
  name: string
  iat: number
  exp?: number
}

export interface CLICredentials {
  token: string
  email: string
  keyName: string
  keyId: string
  storedAt: string
  expiresAt?: string
}

/**
 * Cloud environment configuration
 */
export interface Cloud {
  name: string
  url: string
  builtin?: boolean
}
```

**File:** `cloud/packages/types/src/index.ts`

```typescript
// Existing exports...
export type {
  CLIApiKey,
  CLIApiKeyListItem,
  GenerateCLIKeyRequest,
  GenerateCLIKeyResponse,
  UpdateCLIKeyRequest,
  CLITokenPayload,
  CLICredentials,
  Cloud,
} from "./cli"
```

### 2. CLI Middleware

**File:** `cloud/packages/cloud/src/api/middleware/cli.middleware.ts`

```typescript
import {Request, Response, NextFunction} from "express"
import jwt from "jsonwebtoken"
import {CLITokenPayload} from "@mentra/types"
import {validateToken} from "../../services/console/cli-keys.service"

declare module "express-serve-static-core" {
  interface Request {
    cli?: {
      email: string
      keyId: string
      keyName: string
      type: "cli"
    }
  }
}

const CLI_JWT_SECRET =
  process.env.CLI_AUTH_JWT_SECRET || process.env.CONSOLE_AUTH_JWT_SECRET || process.env.AUGMENTOS_AUTH_JWT_SECRET || ""

export const authenticateCLI = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!CLI_JWT_SECRET) {
      return res.status(500).json({
        error: "Auth configuration error",
        message: "Missing CLI_AUTH_JWT_SECRET",
      })
    }

    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Missing or invalid Authorization header",
        message: "Expected 'Authorization: Bearer <cli-api-key>'",
      })
    }

    const token = authHeader.substring(7)

    // Verify JWT
    let payload: CLITokenPayload
    try {
      payload = jwt.verify(token, CLI_JWT_SECRET) as CLITokenPayload
    } catch {
      return res.status(401).json({
        error: "Invalid or expired CLI API key",
        message: "Token verification failed",
      })
    }

    // Validate payload structure
    if (payload.type !== "cli" || !payload.email || !payload.keyId) {
      return res.status(401).json({
        error: "Invalid token payload",
        message: "Not a valid CLI API key",
      })
    }

    // Check if key is still active in database
    const isValid = await validateToken(token, payload)
    if (!isValid) {
      return res.status(401).json({
        error: "CLI API key revoked or expired",
        message: "This key is no longer valid",
      })
    }

    // Attach CLI auth context
    req.cli = {
      email: payload.email.toLowerCase(),
      keyId: payload.keyId,
      keyName: payload.name,
      type: "cli",
    }

    return next()
  } catch (err) {
    console.error("CLI auth error:", err)
    return res.status(500).json({
      error: "Authentication failed",
      message: "Internal error during authentication",
    })
  }
}

export const cliAuthMiddleware = [authenticateCLI]
```

### 3. CLI Keys Service

**File:** `cloud/packages/cloud/src/services/console/cli-keys.service.ts`

```typescript
import {Types} from "mongoose"
import jwt from "jsonwebtoken"
import crypto from "crypto"
import {v4 as uuidv4} from "uuid"
import CLIKey from "../../models/cli-key.model"
import {User} from "../../models/user.model"
import {GenerateCLIKeyRequest, GenerateCLIKeyResponse, CLIApiKeyListItem, CLITokenPayload} from "@mentra/types"
import {logger as rootLogger} from "../logging/pino-logger"

const logger = rootLogger.child({service: "cli-keys.service"})

const CLI_JWT_SECRET =
  process.env.CLI_AUTH_JWT_SECRET || process.env.CONSOLE_AUTH_JWT_SECRET || process.env.AUGMENTOS_AUTH_JWT_SECRET || ""

export async function generateKey(
  email: string,
  request: GenerateCLIKeyRequest,
  metadata?: {createdFrom?: string; userAgent?: string},
): Promise<GenerateCLIKeyResponse> {
  const user = await User.findOne({email: email.toLowerCase()})
  if (!user) throw new Error("User not found")

  if (!request.name?.trim()) throw new Error("Key name is required")

  // Check duplicate name
  const existing = await CLIKey.findOne({
    userId: user._id,
    name: request.name,
    isActive: true,
  })
  if (existing) throw new Error(`Key "${request.name}" already exists`)

  const keyId = uuidv4()

  // Calculate expiration
  let expiresAt: Date | undefined
  let exp: number | undefined
  if (request.expiresInDays) {
    expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + request.expiresInDays)
    exp = Math.floor(expiresAt.getTime() / 1000)
  }

  // Generate JWT
  const payload: CLITokenPayload = {
    email: user.email,
    type: "cli",
    keyId,
    name: request.name,
    iat: Math.floor(Date.now() / 1000),
    exp,
  }

  const token = jwt.sign(payload, CLI_JWT_SECRET)
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex")

  // Store in DB
  const cliKey = await CLIKey.create({
    keyId,
    userId: user._id,
    email: user.email,
    name: request.name,
    hashedToken,
    expiresAt,
    isActive: true,
    metadata,
  })

  logger.info({keyId, userId: user._id.toString(), name: request.name}, "CLI key generated")

  return {
    keyId: cliKey.keyId,
    name: cliKey.name,
    token,
    createdAt: cliKey.createdAt.toISOString(),
    expiresAt: cliKey.expiresAt?.toISOString(),
  }
}

export async function listKeys(email: string): Promise<CLIApiKeyListItem[]> {
  const user = await User.findOne({email: email.toLowerCase()})
  if (!user) throw new Error("User not found")

  const keys = await CLIKey.find({userId: user._id}).sort({createdAt: -1})

  return keys.map((key) => ({
    keyId: key.keyId,
    name: key.name,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString(),
    expiresAt: key.expiresAt?.toISOString(),
    isActive: key.isActive,
  }))
}

export async function getKey(email: string, keyId: string): Promise<CLIApiKeyListItem> {
  const user = await User.findOne({email: email.toLowerCase()})
  if (!user) throw new Error("User not found")

  const key = await CLIKey.findOne({keyId, userId: user._id})
  if (!key) throw new Error("Key not found")

  return {
    keyId: key.keyId,
    name: key.name,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString(),
    expiresAt: key.expiresAt?.toISOString(),
    isActive: key.isActive,
  }
}

export async function updateKey(email: string, keyId: string, name: string): Promise<CLIApiKeyListItem> {
  const user = await User.findOne({email: email.toLowerCase()})
  if (!user) throw new Error("User not found")

  const key = await CLIKey.findOne({keyId, userId: user._id})
  if (!key) throw new Error("Key not found")

  key.name = name.trim()
  await key.save()

  logger.info({keyId, userId: user._id.toString(), newName: name}, "CLI key renamed")

  return {
    keyId: key.keyId,
    name: key.name,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString(),
    expiresAt: key.expiresAt?.toISOString(),
    isActive: key.isActive,
  }
}

export async function revokeKey(email: string, keyId: string): Promise<{success: boolean}> {
  const user = await User.findOne({email: email.toLowerCase()})
  if (!user) throw new Error("User not found")

  const success = await CLIKey.revokeByUserId(keyId, user._id)
  if (!success) throw new Error("Key not found or already revoked")

  logger.info({keyId, userId: user._id.toString()}, "CLI key revoked")

  return {success: true}
}

export async function validateToken(token: string, payload: CLITokenPayload): Promise<boolean> {
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex")

  const key = await CLIKey.findOne({keyId: payload.keyId, hashedToken})
  if (!key) return false
  if (!key.isValid()) return false

  // Verify email matches
  if (key.email.toLowerCase() !== payload.email.toLowerCase()) {
    logger.warn({keyId: payload.keyId}, "Email mismatch")
    return false
  }

  // Track usage (async)
  CLIKey.trackUsage(payload.keyId).catch((err) => logger.error(err, "Failed to track usage"))

  return true
}

export async function cleanupExpiredKeys(): Promise<number> {
  const count = await CLIKey.cleanupExpired()
  if (count > 0) logger.info({count}, "Cleaned up expired keys")
  return count
}
```

### 4. CLI Keys API Routes

**File:** `cloud/packages/cloud/src/api/console/cli-keys.api.ts`

```typescript
import {Router, Request, Response} from "express"
import {authenticateConsole} from "../middleware/console.middleware"
import {GenerateCLIKeyRequest, UpdateCLIKeyRequest} from "@mentra/types"
import * as cliKeysService from "../../services/console/cli-keys.service"

const router = Router()

// All routes require console authentication
router.use(authenticateConsole)

// Generate new CLI key
router.post("/", generateKey)

// List user's CLI keys
router.get("/", listKeys)

// Get specific key
router.get("/:keyId", getKey)

// Update key (rename)
router.patch("/:keyId", updateKey)

// Revoke key
router.delete("/:keyId", revokeKey)

// Handlers
async function generateKey(req: Request, res: Response) {
  try {
    const email = req.console?.email
    if (!email) {
      return res.status(401).json({error: "Unauthorized"})
    }

    const body = req.body as GenerateCLIKeyRequest
    const metadata = {
      createdFrom: req.ip,
      userAgent: req.headers["user-agent"],
    }

    const result = await cliKeysService.generateKey(email, body, metadata)
    return res.json({success: true, data: result})
  } catch (error: any) {
    return res.status(400).json({error: error.message})
  }
}

async function listKeys(req: Request, res: Response) {
  try {
    const email = req.console?.email
    if (!email) {
      return res.status(401).json({error: "Unauthorized"})
    }

    const keys = await cliKeysService.listKeys(email)
    return res.json({success: true, data: keys})
  } catch (error: any) {
    return res.status(500).json({error: error.message})
  }
}

async function getKey(req: Request, res: Response) {
  try {
    const email = req.console?.email
    if (!email) {
      return res.status(401).json({error: "Unauthorized"})
    }

    const {keyId} = req.params
    const key = await cliKeysService.getKey(email, keyId)
    return res.json({success: true, data: key})
  } catch (error: any) {
    return res.status(404).json({error: error.message})
  }
}

async function updateKey(req: Request, res: Response) {
  try {
    const email = req.console?.email
    if (!email) {
      return res.status(401).json({error: "Unauthorized"})
    }

    const {keyId} = req.params
    const body = req.body as UpdateCLIKeyRequest
    const result = await cliKeysService.updateKey(email, keyId, body.name)
    return res.json({success: true, data: result})
  } catch (error: any) {
    return res.status(400).json({error: error.message})
  }
}

async function revokeKey(req: Request, res: Response) {
  try {
    const email = req.console?.email
    if (!email) {
      return res.status(401).json({error: "Unauthorized"})
    }

    const {keyId} = req.params
    const result = await cliKeysService.revokeKey(email, keyId)
    return res.json({success: true, data: result})
  } catch (error: any) {
    return res.status(400).json({error: error.message})
  }
}

export default router
```

### 5. Refactor Console Routes (Remove Per-Route Middleware)

**IMPORTANT:** Console routes must be refactored to **not include middleware** in route definitions.

**File:** `cloud/packages/cloud/src/api/console/console.apps.api.ts` (UPDATED)

```typescript
/**
 * Console App API
 *
 * Base: /api/console/apps (or /api/cli/apps with CLI auth)
 *
 * NOTE: No middleware in route definitions!
 * Auth is applied at mount point to allow reuse with different auth contexts.
 */

import {Router, Request, Response} from "express"
// NO import of authenticateConsole

const router = Router()

// Routes WITHOUT middleware
router.get("/", listApps)
router.post("/", createApp)
router.get("/:packageName", getApp)
router.put("/:packageName", updateApp)
router.delete("/:packageName", deleteApp)
router.post("/:packageName/publish", publishApp)
router.post("/:packageName/api-key", regenerateApiKey)
router.post("/:packageName/move", moveApp)

// Handlers remain unchanged - they check req.console?.email
async function listApps(req: Request, res: Response) {
  const email = req.console?.email
  if (!email) return res.status(401).json({error: "Unauthorized"})
  // ... rest of handler
}

// ... other handlers

export default router
```

**Same pattern for:** `orgs.api.ts`, `console.account.api.ts`

### 6. Mount Routes with Auth Middleware

**File:** `cloud/packages/cloud/src/api/index.ts`

```typescript
import express from "express"
import consoleAppsRouter from "./console/console.apps.api"
import consoleOrgsRouter from "./console/orgs.api"
import cliKeysRouter from "./console/cli-keys.api"
import {authenticateConsole} from "./middleware/console.middleware"
import {authenticateCLI} from "./middleware/cli.middleware"

const app = express()

/**
 * Console routes - apply console auth at mount
 */
app.use("/api/console/apps", authenticateConsole, consoleAppsRouter)
app.use("/api/console/orgs", authenticateConsole, consoleOrgsRouter)
app.use("/api/console/cli-keys", authenticateConsole, cliKeysRouter)

/**
 * CLI routes - apply CLI auth + transform, reuse console routers
 * Transform: req.cli → req.console (handlers expect req.console)
 */
const transformCLIToConsole = (req: any, _res: any, next: any) => {
  if (req.cli) {
    req.console = {email: req.cli.email}
  }
  next()
}

app.use("/api/cli/apps", authenticateCLI, transformCLIToConsole, consoleAppsRouter)
app.use("/api/cli/orgs", authenticateCLI, transformCLIToConsole, consoleOrgsRouter)

export default app
```

**Key points:**

1. Console routes get `authenticateConsole` at mount
2. CLI routes get `authenticateCLI` + transform at mount
3. Same router works for both contexts
4. Handlers check `req.console?.email` (works for both)

## CLI Tool Implementation

### Directory Structure

```
cloud/packages/cli/
├── src/
│   ├── commands/
│   │   ├── auth.ts          # auth, logout, whoami
│   │   ├── app.ts           # app list/create/get/update/delete/publish
│   │   ├── org.ts           # org list/get/switch
│   │   ├── cloud.ts         # cloud list/use/add/remove
│   │   └── config.ts        # config get/set/list
│   ├── api/
│   │   └── client.ts        # HTTP client with auth
│   ├── config/
│   │   ├── credentials.ts   # Bun.secrets + file fallback
│   │   ├── clouds.ts        # Cloud management
│   │   ├── clouds.yaml      # Built-in clouds
│   │   └── settings.ts      # Read/write ~/.mentra/config.json
│   ├── utils/
│   │   ├── output.ts        # Table/JSON formatting
│   │   ├── prompt.ts        # Interactive prompts
│   │   ├── validation.ts    # Input validation
│   │   └── errors.ts        # Error handling
│   └── index.ts             # CLI entry point
├── package.json
├── tsconfig.json
└── README.md
```

### Entry Point

**File:** `packages/cli/src/index.ts`

```typescript
#!/usr/bin/env bun
import {Command} from "commander"
import {authCommand} from "./commands/auth"
import {appCommand} from "./commands/app"
import {orgCommand} from "./commands/org"
import {configCommand} from "./commands/config"

const program = new Command()

program.name("mentra").description("MentraOS CLI - Manage apps and organizations").version("1.0.0")

// Commands
program.addCommand(authCommand)
program.addCommand(appCommand)
program.addCommand(orgCommand)
program.addCommand(configCommand)

// Global options
program.option("--json", "Output JSON")
program.option("--quiet", "Suppress non-essential output")
program.option("--verbose", "Show debug info")
program.option("--no-color", "Disable colors")

program.parse()
```

### API Client

**File:** `packages/cli/src/api/client.ts`

```typescript
import axios, {AxiosInstance} from "axios"
import {loadCredentials} from "../config/credentials"
import {getApiUrl} from "../config/clouds"

export class APIClient {
  private client: AxiosInstance

  constructor() {
    const creds = loadCredentials()

    this.client = axios.create({
      baseURL: getApiUrl(), // Uses current cloud or MENTRA_API_URL
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        ...(creds?.token && {Authorization: `Bearer ${creds.token}`}),
      },
    })
  }

  // Apps
  async listApps(orgId?: string) {
    const params = orgId ? {orgId} : undefined
    const res = await this.client.get("/api/cli/apps", {params})
    return res.data?.data ?? res.data
  }

  async createApp(data: any) {
    const res = await this.client.post("/api/cli/apps", data)
    return res.data?.data ?? res.data
  }

  async getApp(packageName: string) {
    const res = await this.client.get(`/api/cli/apps/${encodeURIComponent(packageName)}`)
    return res.data?.data ?? res.data
  }

  async updateApp(packageName: string, data: any) {
    const res = await this.client.put(`/api/cli/apps/${encodeURIComponent(packageName)}`, data)
    return res.data?.data ?? res.data
  }

  async deleteApp(packageName: string) {
    const res = await this.client.delete(`/api/cli/apps/${encodeURIComponent(packageName)}`)
    return res.data?.data ?? res.data
  }

  async publishApp(packageName: string) {
    const res = await this.client.post(`/api/cli/apps/${encodeURIComponent(packageName)}/publish`)
    return res.data?.data ?? res.data
  }

  async regenerateApiKey(packageName: string) {
    const res = await this.client.post(`/api/cli/apps/${encodeURIComponent(packageName)}/api-key`)
    return res.data?.data ?? res.data
  }

  // Orgs
  async listOrgs() {
    const res = await this.client.get("/api/cli/orgs")
    return res.data?.data ?? res.data
  }

  async getOrg(orgId: string) {
    const res = await this.client.get(`/api/cli/orgs/${orgId}`)
    return res.data?.data ?? res.data
  }
}

export const api = new APIClient()
```

### Credentials Management

**File:** `packages/cli/src/config/credentials.ts`

```typescript
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
    if (typeof Bun?.secrets !== "undefined") {
      await Bun.secrets.set({
        service: "mentra-cli",
        name: "credentials",
        value: JSON.stringify(creds),
      })
      console.log("✓ Credentials saved securely to OS keychain")
      return
    }
  } catch (error) {
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
    if (typeof Bun?.secrets !== "undefined") {
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
    return null
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
    if (typeof Bun?.secrets !== "undefined") {
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
```

### Cloud Management

**File:** `packages/cli/src/config/clouds.yaml`

```yaml
# Built-in clouds
production:
  name: Production
  url: https://api.mentra.glass
  default: true

staging:
  name: Staging
  url: https://staging-api.mentra.glass

development:
  name: Development
  url: https://dev-api.mentra.glass

local:
  name: Local Development
  url: http://localhost:8002
```

**File:** `packages/cli/src/config/clouds.ts`

```typescript
import {readFileSync} from "fs"
import {join} from "path"
import yaml from "yaml"
import {getConfig, updateConfig} from "./settings"
import {Cloud} from "@mentra/types"

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
export function addCloud(key: string, cloud: Omit<Cloud, "builtin">): void {
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
```

**File:** `packages/cli/src/commands/cloud.ts`

```typescript
import {Command} from "commander"
import {getAllClouds, getCurrentCloud, switchCloud, addCloud, removeCloud} from "../config/clouds"
import {displayTable} from "../utils/output"
import {input} from "../utils/prompt"

export const cloudCommand = new Command("cloud").description("Manage Mentra clouds")

// List clouds
cloudCommand
  .command("list")
  .alias("ls")
  .description("List available clouds")
  .action(() => {
    const allClouds = getAllClouds()
    const {key: currentKey} = getCurrentCloud()

    const rows = Object.entries(allClouds).map(([key, cloud]) => ({
      current: key === currentKey ? "*" : " ",
      key,
      name: cloud.name,
      url: cloud.url,
      type: cloud.builtin ? "built-in" : "custom",
    }))

    displayTable(rows, ["current", "key", "name", "url", "type"])
    console.log(`\n* = current cloud`)
  })

// Show current cloud
cloudCommand
  .command("current")
  .description("Show current cloud")
  .action(() => {
    const {key, cloud} = getCurrentCloud()
    console.log(`${key} (${cloud.url})`)
  })

// Switch cloud
cloudCommand
  .command("use")
  .argument("<cloud>", "Cloud to switch to")
  .description("Switch to a different cloud")
  .action((cloudKey: string) => {
    try {
      const {cloud: oldCloud} = getCurrentCloud()

      switchCloud(cloudKey)
      const newCloud = getAllClouds()[cloudKey]

      console.log(`✓ Switched from ${oldCloud.url}`)
      console.log(`  to ${newCloud.name} (${newCloud.url})`)
    } catch (error: any) {
      console.error(`✗ ${error.message}`)
      process.exit(1)
    }
  })

// Add custom cloud
cloudCommand
  .command("add")
  .argument("[key]", "Cloud key (e.g., my-staging)")
  .option("--name <name>", "Display name")
  .option("--url <url>", "API URL")
  .description("Add a custom cloud")
  .action(async (key?: string, options?: any) => {
    try {
      let cloudKey = key
      let name = options?.name
      let url = options?.url

      // Interactive mode if no args
      if (!cloudKey) {
        cloudKey = await input("Cloud key:", {required: true})
        name = await input("Display name:", {required: true})
        url = await input("API URL:", {required: true})
      }

      if (!name || !url) {
        console.error("✗ --name and --url are required in non-interactive mode")
        process.exit(2)
      }

      addCloud(cloudKey!, {name, url})
      console.log(`✓ Added cloud '${cloudKey}'`)
    } catch (error: any) {
      console.error(`✗ ${error.message}`)
      process.exit(1)
    }
  })

// Remove custom cloud
cloudCommand
  .command("remove")
  .alias("rm")
  .argument("<cloud>", "Cloud to remove")
  .description("Remove a custom cloud")
  .action((cloudKey: string) => {
    try {
      removeCloud(cloudKey)
      console.log(`✓ Removed cloud '${cloudKey}'`)
    } catch (error: any) {
      console.error(`✗ ${error.message}`)
      process.exit(1)
    }
  })
```

### Auth Commands

**File:** `packages/cli/src/commands/auth.ts`

```typescript
import {Command} from "commander"
import {saveCredentials, loadCredentials, clearCredentials} from "../config/credentials"
import {getCurrentCloud} from "../config/clouds"
import jwt from "jsonwebtoken"

export const authCommand = new Command("auth")
  .description("Authenticate with CLI API key")
  .argument("<token>", "CLI API key from console")
  .action(async (token: string) => {
    try {
      // Validate token format
      const decoded = jwt.decode(token) as any
      if (!decoded || decoded.type !== "cli") {
        console.error("✗ Invalid CLI API key format")
        process.exit(2)
      }

      // Save credentials
      await saveCredentials(token)

      console.log(`✓ Authenticated as ${decoded.email}`)
      console.log(`✓ CLI key: ${decoded.name}`)

      const {cloud} = getCurrentCloud()
      console.log(`✓ Cloud: ${cloud.name} (${cloud.url})`)
    } catch (error: any) {
      console.error("✗ Authentication failed:", error.message)
      process.exit(1)
    }
  })

// Logout command
authCommand
  .command("logout")
  .description("Clear stored credentials")
  .action(async () => {
    await clearCredentials()
    console.log("✓ Logged out")
  })

// Whoami command
authCommand
  .command("whoami")
  .description("Show current authentication info")
  .action(async () => {
    const creds = await loadCredentials()
    if (!creds) {
      console.error("Not authenticated")
      process.exit(3)
    }

    const {key: cloudKey, cloud} = getCurrentCloud()

    console.log(`Email:       ${creds.email}`)
    console.log(`Cloud:       ${cloud.name} (${cloud.url})`)
    console.log(`CLI Key:     ${creds.keyName}`)
    console.log(`Stored:      ${new Date(creds.storedAt).toLocaleString()}`)
    if (creds.expiresAt) {
      console.log(`Expires:     ${new Date(creds.expiresAt).toLocaleString()}`)
    }
  })
```

### App Commands

**File:** `packages/cli/src/commands/app.ts`

```typescript
import {Command} from "commander"
import {api} from "../api/client"
import {requireAuth} from "../config/credentials"
import {displayTable, displayJSON} from "../utils/output"
import {confirm, input, select} from "../utils/prompt"
import {writeFileSync, readFileSync} from "fs"

export const appCommand = new Command("app").description("Manage apps")

// List apps
appCommand
  .command("list")
  .description("List apps")
  .option("--org <id>", "Organization ID")
  .action(async (options) => {
    requireAuth()
    try {
      const apps = await api.listApps(options.org)

      if (options.parent.json) {
        displayJSON(apps)
      } else {
        displayTable(apps, ["packageName", "name", "appType", "appStoreStatus"])
        console.log(`\n${apps.length} apps total`)
      }
    } catch (error: any) {
      console.error("✗ Failed to list apps:", error.message)
      process.exit(1)
    }
  })

// Create app
appCommand
  .command("create")
  .description("Create new app")
  .option("--package-name <name>", "Package name")
  .option("--name <name>", "App name")
  .option("--description <desc>", "Description")
  .option("--app-type <type>", "App type (background|standard)")
  .option("--public-url <url>", "Public URL")
  .option("--logo-url <url>", "Logo URL")
  .action(async (options) => {
    requireAuth()
    try {
      let data: any = {}

      // Interactive mode if no flags provided
      if (!options.packageName) {
        data.packageName = await input("Package name:", {required: true})
        data.name = await input("App name:", {required: true})
        data.description = await input("Description:", {required: true})
        data.appType = await select("App type:", ["background", "standard"])
        data.publicUrl = await input("Public URL:", {required: true})
        data.logoURL = await input("Logo URL (optional):")
      } else {
        // Flag-based mode
        data = {
          packageName: options.packageName,
          name: options.name,
          description: options.description,
          appType: options.appType || "background",
          publicUrl: options.publicUrl,
          logoURL: options.logoUrl,
        }
      }

      const result = await api.createApp(data)

      console.log(`✓ App created: ${result.app.packageName}`)
      console.log(`🔑 API Key: ${result.apiKey}`)
      console.log(`\n⚠️  SAVE THIS KEY - it won't be shown again!`)
    } catch (error: any) {
      console.error("✗ Failed to create app:", error.message)
      process.exit(1)
    }
  })

// Get app
appCommand
  .command("get")
  .description("Get app details")
  .argument("<package-name>", "Package name")
  .action(async (packageName: string, options) => {
    requireAuth()
    try {
      const app = await api.getApp(packageName)
      displayJSON(app)
    } catch (error: any) {
      console.error("✗ App not found:", error.message)
      process.exit(5)
    }
  })

// Update app
appCommand
  .command("update")
  .description("Update app")
  .argument("<package-name>", "Package name")
  .option("--name <name>", "App name")
  .option("--description <desc>", "Description")
  .option("--add-permission <type>", "Add permission")
  .option("--remove-permission <type>", "Remove permission")
  .action(async (packageName: string, options) => {
    requireAuth()
    try {
      const updates: any = {}

      if (options.name) updates.name = options.name
      if (options.description) updates.description = options.description

      // Handle permissions
      if (options.addPermission || options.removePermission) {
        const app = await api.getApp(packageName)
        const permissions = app.permissions || []

        if (options.addPermission) {
          permissions.push({type: options.addPermission, description: ""})
        }
        if (options.removePermission) {
          const idx = permissions.findIndex((p: any) => p.type === options.removePermission)
          if (idx >= 0) permissions.splice(idx, 1)
        }

        updates.permissions = permissions
      }

      await api.updateApp(packageName, updates)
      console.log("✓ App updated")
    } catch (error: any) {
      console.error("✗ Failed to update app:", error.message)
      process.exit(1)
    }
  })

// Delete app
appCommand
  .command("delete")
  .description("Delete app")
  .argument("<package-name>", "Package name")
  .option("--force", "Skip confirmation")
  .action(async (packageName: string, options) => {
    requireAuth()
    try {
      if (!options.force) {
        const confirmed = await confirm(`Delete app ${packageName}?`)
        if (!confirmed) {
          console.log("Cancelled")
          return
        }
      }

      await api.deleteApp(packageName)
      console.log("✓ App deleted")
    } catch (error: any) {
      console.error("✗ Failed to delete app:", error.message)
      process.exit(1)
    }
  })

// Publish app
appCommand
  .command("publish")
  .description("Publish app to store")
  .argument("<package-name>", "Package name")
  .action(async (packageName: string) => {
    requireAuth()
    try {
      await api.publishApp(packageName)
      console.log("✓ App submitted for review")
    } catch (error: any) {
      console.error("✗ Failed to publish app:", error.message)
      process.exit(1)
    }
  })

// Regenerate API key
appCommand
  .command("api-key")
  .description("Regenerate app API key")
  .argument("<package-name>", "Package name")
  .option("--force", "Skip confirmation")
  .action(async (packageName: string, options) => {
    requireAuth()
    try {
      if (!options.force) {
        console.log("⚠️  WARNING: This will invalidate the existing API key!")
        const confirmed = await confirm("Continue?")
        if (!confirmed) {
          console.log("Cancelled")
          return
        }
      }

      const result = await api.regenerateApiKey(packageName)
      console.log(`🔑 New API Key: ${result.apiKey}`)
      console.log(`\n⚠️  SAVE THIS KEY - it won't be shown again!`)
    } catch (error: any) {
      console.error("✗ Failed to regenerate API key:", error.message)
      process.exit(1)
    }
  })

// Export app
appCommand
  .command("export")
  .description("Export app config to JSON")
  .argument("<package-name>", "Package name")
  .option("-o, --output <file>", "Output file (default: <package-name>.json)")
  .action(async (packageName: string, options) => {
    requireAuth()
    try {
      const app = await api.getApp(packageName)

      // Remove fields that shouldn't be exported
      delete app.id
      delete app.createdAt
      delete app.updatedAt
      delete app.organizationId

      const json = JSON.stringify(app, null, 2)

      if (options.output === "-") {
        // Output to stdout
        console.log(json)
      } else {
        // Write to file
        const filename = options.output || `${packageName}.json`
        writeFileSync(filename, json)
        console.log(`✓ Exported to ${filename}`)
      }
    } catch (error: any) {
      console.error("✗ Failed to export app:", error.message)
      process.exit(1)
    }
  })

// Import app
appCommand
  .command("import")
  .description("Import app config from JSON")
  .argument("<file>", "JSON file")
  .option("--force", "Skip confirmation")
  .action(async (file: string, options) => {
    requireAuth()
    try {
      const json = readFileSync(file, "utf-8")
      const config = JSON.parse(json)

      if (!config.packageName) {
        console.error("✗ Invalid config: missing packageName")
        process.exit(2)
      }

      // Show changes (simplified)
      console.log(`Importing config for ${config.packageName}`)

      if (!options.force) {
        const confirmed = await confirm("Apply changes?")
        if (!confirmed) {
          console.log("Cancelled")
          return
        }
      }

      await api.updateApp(config.packageName, config)
      console.log("✓ App updated")
    } catch (error: any) {
      console.error("✗ Failed to import app:", error.message)
      process.exit(1)
    }
  })
```

### Package.json

**File:** `packages/cli/package.json`

```json
{
  "name": "@mentra/cli",
  "version": "1.0.0",
  "description": "MentraOS CLI tool",
  "type": "module",
  "bin": {
    "mentra": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "bun run src/index.ts",
    "prepublishOnly": "bun run build"
  },
  "dependencies": {
    "@mentra/types": "workspace:*",
    "commander": "^11.0.0",
    "axios": "^1.6.0",
    "jsonwebtoken": "^9.0.2",
    "cli-table3": "^0.6.3",
    "chalk": "^5.3.0",
    "inquirer": "^9.2.0",
    "yaml": "^2.3.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/jsonwebtoken": "^9.0.0",
    "typescript": "^5.0.0",
    "bun-types": "latest"
  }
}
```

## Console UI Implementation

### CLI Keys Settings Page

**File:** `cloud/websites/console/src/pages/CLIKeys.tsx`

```tsx
import {useState, useEffect} from "react"
import {Button} from "@/components/ui/button"
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card"
import {Input} from "@/components/ui/input"
import {Label} from "@/components/ui/label"
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table"
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import {Alert, AlertDescription} from "@/components/ui/alert"
import {Copy, Key, Trash2, Edit2, AlertCircle} from "lucide-react"
import {toast} from "sonner"
import api from "@/services/api.service"
import DashboardLayout from "@/components/DashboardLayout"

export default function CLIKeys() {
  const [keys, setKeys] = useState([])
  const [loading, setLoading] = useState(true)
  const [showGenerateDialog, setShowGenerateDialog] = useState(false)
  const [newKeyName, setNewKeyName] = useState("")
  const [generatedToken, setGeneratedToken] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    loadKeys()
  }, [])

  async function loadKeys() {
    try {
      setLoading(true)
      const response = await api.console.cliKeys.list()
      setKeys(response)
    } catch (error) {
      toast.error("Failed to load CLI keys")
    } finally {
      setLoading(false)
    }
  }

  async function generateKey() {
    if (!newKeyName.trim()) {
      toast.error("Key name is required")
      return
    }

    try {
      setGenerating(true)
      const response = await api.console.cliKeys.generate({name: newKeyName})
      setGeneratedToken(response.token)
      setNewKeyName("")
      await loadKeys()
    } catch (error: any) {
      toast.error(error.response?.data?.error || "Failed to generate key")
    } finally {
      setGenerating(false)
    }
  }

  async function revokeKey(keyId: string) {
    if (!confirm("Are you sure you want to revoke this key?")) return

    try {
      await api.console.cliKeys.revoke(keyId)
      toast.success("Key revoked")
      await loadKeys()
    } catch (error) {
      toast.error("Failed to revoke key")
    }
  }

  function copyToken() {
    if (generatedToken) {
      navigator.clipboard.writeText(generatedToken)
      toast.success("Token copied to clipboard")
    }
  }

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">CLI API Keys</h1>
          <Button onClick={() => setShowGenerateDialog(true)}>
            <Key className="h-4 w-4 mr-2" />
            Generate New Key
          </Button>
        </div>

        <Alert className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            CLI API keys allow you to use the MentraOS CLI tool from your terminal. Generate a key, then run:{" "}
            <code className="bg-gray-100 px-2 py-1 rounded">mentra auth &lt;token&gt;</code>
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle>Your CLI Keys</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p>Loading...</p>
            ) : keys.length === 0 ? (
              <p className="text-gray-500">No CLI keys yet. Generate one to get started.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last Used</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((key: any) => (
                    <TableRow key={key.keyId}>
                      <TableCell>{key.name}</TableCell>
                      <TableCell>{new Date(key.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "Never"}</TableCell>
                      <TableCell>
                        <span className={key.isActive ? "text-green-600" : "text-gray-400"}>
                          {key.isActive ? "Active" : "Revoked"}
                        </span>
                      </TableCell>
                      <TableCell>
                        {key.isActive && (
                          <Button variant="ghost" size="sm" onClick={() => revokeKey(key.keyId)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Generate Key Dialog */}
        <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Generate CLI API Key</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Key Name</Label>
                <Input placeholder="My Laptop" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} />
              </div>
              <Button onClick={generateKey} disabled={generating}>
                {generating ? "Generating..." : "Generate Key"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Token Display Dialog */}
        <Dialog open={!!generatedToken} onOpenChange={() => setGeneratedToken(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>CLI API Key Generated</DialogTitle>
            </DialogHeader>
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>Copy this token now - you won't be able to see it again!</AlertDescription>
            </Alert>
            <div className="bg-gray-100 p-4 rounded font-mono text-sm break-all">{generatedToken}</div>
            <Button onClick={copyToken}>
              <Copy className="h-4 w-4 mr-2" />
              Copy Token
            </Button>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}
```

### API Service Extension

**File:** `cloud/websites/console/src/services/api.service.ts` (additions)

```typescript
// Add to existing api object
api.console.cliKeys = {
  list: async () => {
    const res = await axios.get("/api/console/cli-keys")
    return res.data?.data ?? res.data
  },

  generate: async (data: {name: string; expiresInDays?: number}) => {
    const res = await axios.post("/api/console/cli-keys", data)
    return res.data?.data ?? res.data
  },

  get: async (keyId: string) => {
    const res = await axios.get(`/api/console/cli-keys/${keyId}`)
    return res.data?.data ?? res.data
  },

  update: async (keyId: string, data: {name: string}) => {
    const res = await axios.patch(`/api/console/cli-keys/${keyId}`, data)
    return res.data?.data ?? res.data
  },

  revoke: async (keyId: string) => {
    const res = await axios.delete(`/api/console/cli-keys/${keyId}`)
    return res.data?.data ?? res.data
  },
}
```

## Testing Strategy

### Backend Tests

```typescript
// Test CLI middleware
describe("CLI Middleware", () => {
  test("rejects missing token", async () => {
    const res = await request(app).get("/api/cli/apps")
    expect(res.status).toBe(401)
  })

  test("rejects invalid token", async () => {
    const res = await request(app).get("/api/cli/apps").set("Authorization", "Bearer invalid")
    expect(res.status).toBe(401)
  })

  test("rejects revoked token", async () => {
    // Generate and revoke key
    const key = await generateTestKey()
    await CLIKey.revokeByUserId(key.keyId, userId)

    const res = await request(app).get("/api/cli/apps").set("Authorization", `Bearer ${key.token}`)
    expect(res.status).toBe(401)
  })

  test("accepts valid token", async () => {
    const key = await generateTestKey()
    const res = await request(app).get("/api/cli/apps").set("Authorization", `Bearer ${key.token}`)
    expect(res.status).toBe(200)
  })
})

// Test CLI keys service
describe("CLI Keys Service", () => {
  test("generates key", async () => {
    const result = await generateKey("dev@example.com", {name: "Test"})
    expect(result.token).toBeTruthy()
    expect(result.keyId).toBeTruthy()
  })

  test("prevents duplicate names", async () => {
    await generateKey("dev@example.com", {name: "Test"})
    await expect(generateKey("dev@example.com", {name: "Test"})).rejects.toThrow()
  })

  test("lists user keys", async () => {
    await generateKey("dev@example.com", {name: "Key1"})
    await generateKey("dev@example.com", {name: "Key2"})
    const keys = await listKeys("dev@example.com")
    expect(keys).toHaveLength(2)
  })

  test("revokes key", async () => {
    const key = await generateKey("dev@example.com", {name: "Test"})
    await revokeKey("dev@example.com", key.keyId)
    const keys = await listKeys("dev@example.com")
    expect(keys[0].isActive).toBe(false)
  })
})
```

### CLI Tests

```typescript
// Test credentials management
describe("Credentials", () => {
  test("saves credentials", () => {
    const token = generateTestToken()
    saveCredentials(token)
    const creds = loadCredentials()
    expect(creds?.token).toBe(token)
  })

  test("clears credentials", () => {
    saveCredentials(generateTestToken())
    clearCredentials()
    expect(loadCredentials()).toBeNull()
  })
})

// Test API client
describe("API Client", () => {
  test("includes auth header", () => {
    const client = new APIClient()
    expect(client.defaults.headers.Authorization).toMatch(/^Bearer /)
  })
})
```

## Migration Plan

### Step 1: Refactor Console Routes (No Breaking Change)

Refactor existing console routes to remove per-route middleware:

```typescript
// BEFORE (console.apps.api.ts)
router.get("/", authenticateConsole, listApps)

// AFTER (console.apps.api.ts)
router.get("/", listApps) // No middleware
```

**Files to update:**

- `api/console/console.apps.api.ts`
- `api/console/orgs.api.ts`
- `api/console/console.account.api.ts`

Then update mounting in `api/index.ts` to apply middleware at mount point.

**This is backward compatible** - same auth, same behavior, just different location.

### Step 2: Add CLI Infrastructure

1. Create CLI middleware (`cli.middleware.ts`)
2. Create CLI keys service + API routes
3. Create CLIKey model
4. Add transform middleware
5. Mount CLI routes with auth + transform

### Step 3: Deploy & Test

```bash
# Deploy backend
cd cloud/packages/cloud
bun run build
git push production main

# Verify console routes still work
curl https://api.mentra.glass/api/console/apps \
  -H "Authorization: Bearer <console-token>"

# Verify CLI routes work
curl https://api.mentra.glass/api/cli/apps \
  -H "Authorization: Bearer <cli-api-key>"
```

## Deployment

### 1. Backend Deployment

```bash
# Build and deploy
cd cloud/packages/cloud
bun run build
git push production main

# MongoDB auto-creates CLIKey collection on first insert

# Test endpoints
curl https://api.mentra.glass/api/console/cli-keys \
  -H "Authorization: Bearer <console-token>"
```

### 2. CLI Tool Publishing

```bash
# Build CLI
cd cloud/packages/cli
bun run build

# Publish to npm
npm publish --access public

# Verify
npm install -g @mentra/cli
mentra --version
```

### 3. Console UI Deployment

```bash
# Deploy console website with new CLI keys page
cd cloud/websites/console
bun run build
# Deploy static assets
```

## Monitoring

### Metrics to Track

```typescript
// Key generation rate
cliKeys.generated.total
cliKeys.generated.rate

// Key usage
cliKeys.usage.total
cliKeys.usage.rate
cliKeys.lastUsed.avg

// Revocations
cliKeys.revoked.total
cliKeys.revoked.rate

// Auth failures
cliKeys.auth.failures.total
cliKeys.auth.failures.rate
```

### Logging

```typescript
logger.info({keyId, userId, action: "generated"}, "CLI key generated")
logger.info({keyId, action: "used"}, "CLI key used")
logger.warn({keyId, reason: "revoked"}, "CLI key auth failed")
logger.error({error}, "CLI key generation failed")
```

## Security Considerations

1. **Token Storage**:
   - Primary: OS keychain via `Bun.secrets` (encrypted at rest)
   - Fallback: `chmod 600` on `~/.mentra/credentials.json`
   - CI/CD: `MENTRA_CLI_TOKEN` environment variable
2. **Token Exposure**: Never log tokens, only keyId
3. **Revocation**: Immediate via database check
4. **Rate Limiting**: Limit key generation to 10/hour per user
5. **Expiration**: Support optional expiration dates
6. **Audit Trail**: Log all key operations with timestamps
7. **Bun Version**: Require Bun 1.3+ for `Bun.secrets` support

## Route Refactoring Checklist

**Phase 1: Refactor Console Routes**

- [ ] Remove `authenticateConsole` from `console.apps.api.ts` routes
- [ ] Remove `authenticateConsole` from `orgs.api.ts` routes
- [ ] Remove `authenticateConsole` from `console.account.api.ts` routes
- [ ] Update `api/index.ts` to apply auth at mount for console routes
- [ ] Test console UI still works
- [ ] Deploy refactored console routes

**Phase 2: Add CLI Infrastructure**

- [ ] Create `cli.middleware.ts`
- [ ] Create `cli-key.model.ts`
- [ ] Create `cli-keys.service.ts`
- [ ] Create `cli-keys.api.ts` (console auth)
- [ ] Add transform middleware in `api/index.ts`
- [ ] Mount CLI routes with CLI auth + transform
- [ ] Test CLI routes work
- [ ] Deploy CLI infrastructure

**Phase 3: CLI Tool & Console UI**

- [ ] Build CLI tool (`packages/cli/`)
- [ ] Add cloud management (`clouds.yaml`, `clouds.ts`, `cloud.ts` command)
- [ ] Implement `Bun.secrets` with file fallback
- [ ] Build console UI page (`CLIKeys.tsx`)
- [ ] Publish CLI to npm (require Bun 1.3+)
- [ ] Deploy console UI updates
- [ ] Documentation (including cloud management and `Bun.secrets`)

## Open Questions

1. **Cleanup cron job frequency?** → Daily at 3am UTC
2. **Max keys per user?** → 10 active keys
3. **Default expiration?** → Never (user can set)
4. **Track IP per usage?** → Phase 2 (storage cost)
5. **Email on new key generation?** → Phase 2 (security notification)
6. **Auto-migrate file to Bun.secrets?** → Yes, on next auth command
7. **Cloud auto-detection from API?** → Phase 2 (detect region from response)
