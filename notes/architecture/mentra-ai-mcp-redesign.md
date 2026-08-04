# Mentra AI + MCP Tool System Redesign

## Executive Summary

This document outlines a complete redesign of the MentraOS tool calling system, replacing the current bespoke LangChain-based implementation with a modern Mastra + MCP architecture.

**Key Changes:**

1. Replace LangChain agents with Mastra framework
2. Adopt MCP (Model Context Protocol) as the tool format standard
3. Cloud serves as centralized MCP server (aggregates all mini-app tools)
4. Mini-apps register tools via MCP schema but serve simple HTTP endpoints
5. Hardware-aware tool filtering (only show tools from compatible apps)
6. Auto-activate apps when their tools are called

---

## Architecture Boundaries

**Critical Design Principle:** The cloud is **stateless plumbing**. It routes messages, executes tools, and manages sessions—but does NOT hold AI conversation state.

| Responsibility | Where It Lives |
|----------------|----------------|
| Tool Registry (aggregating tools from apps) | Cloud |
| Tool Execution (routing calls to apps) | Cloud |
| App Activation (starting apps for tool calls) | Cloud |
| Hardware Compatibility Filtering | Cloud |
| Session Management | Cloud |
| **Conversation History** | **Mentra AI Mini-App** |
| **AI Agent Logic (Mastra)** | **Mentra AI Mini-App** |
| **LLM API Calls** | **Mentra AI Mini-App** |
| **Response Generation** | **Mentra AI Mini-App** |

The Mentra AI mini-app is a first-party app that uses the same SDK as third-party apps. It subscribes to transcription events, maintains conversation history, calls the LLM, and uses the tool system just like any other app would.

---

## Current State (Problems)

```
┌─────────────────────────────────────────────────────────────────┐
│                     CURRENT ARCHITECTURE                        │
│                                                                 │
│  User Voice ──► Transcription ──► Mentra AI (LangChain Agent)  │
│                                         │                       │
│                                         ▼                       │
│                              AgentGatekeeper                    │
│                              (LLM selects agents)               │
│                                         │                       │
│                         ┌───────────────┼───────────────┐       │
│                         ▼               ▼               ▼       │
│                   NewsAgent      MentraAgent     OtherAgents    │
│                         │               │                       │
│                         └───────┬───────┘                       │
│                                 ▼                               │
│                    Tool Discovery (REST)                        │
│                    GET /api/tools/users/:userId/tools           │
│                                 │                               │
│                                 ▼                               │
│                    Tool Execution (HTTP POST)                   │
│                    POST /api/tools/apps/:pkg/tool               │
│                                 │                               │
│                                 ▼                               │
│                         Mini-App /tool endpoint                 │
│                         (may have activeSession=null)  ← BROKEN │
└─────────────────────────────────────────────────────────────────┘

Problems:
1. Bespoke tool schema (not MCP compatible)
2. LangChain overhead and complexity
3. No app activation when tool needs display
4. Scattered tool discovery across REST endpoints
5. No streaming support
6. Poor error handling and observability
```

---

## New Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           NEW ARCHITECTURE                                    │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        MentraOS Cloud                                   │  │
│  │                    (Stateless Plumbing Layer)                          │  │
│  │                                                                         │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │                   Tool Registry Service                          │   │  │
│  │  │                                                                  │   │  │
│  │  │  - Aggregates tools from all installed apps                     │   │  │
│  │  │  - Filters by hardware compatibility                            │   │  │
│  │  │  - Serves MCP-formatted tool list                               │   │  │
│  │  │                                                                  │   │  │
│  │  │  GET /api/tools (X-User-Id header)                              │   │  │
│  │  │  Response: [                                                     │   │  │
│  │  │    { name: "com.app1:add_reminder", ... },                      │   │  │
│  │  │    { name: "com.app1:list_reminders", ... },                    │   │  │
│  │  │    { name: "com.app2:play_song", ... },                         │   │  │
│  │  │  ]                                                               │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                              │                                          │  │
│  │                              │ Tool Execution                           │  │
│  │                              ▼                                          │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │                 Tool Executor Service                            │   │  │
│  │  │                                                                  │   │  │
│  │  │  POST /api/tools/execute (X-User-Id header)                     │   │  │
│  │  │                                                                  │   │  │
│  │  │  1. Parse tool name: "com.app1:add_reminder"                    │   │  │
│  │  │     └─► packageName="com.app1", toolName="add_reminder"         │   │  │
│  │  │  2. Start app if not running (AppManager.startApp)              │   │  │
│  │  │  3. Wait for app to connect (polling with timeout)              │   │  │
│  │  │  4. Execute via HTTP POST to app's /tool endpoint               │   │  │
│  │  │  5. Return result with proper error handling                    │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                              │                                          │  │
│  └──────────────────────────────┼──────────────────────────────────────────┘  │
│                                 │                                             │
│                                 ▼                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                           Mini-Apps                                     │  │
│  │                                                                         │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐        │  │
│  │  │  Mentra AI App  │  │    App 2        │  │    App 3        │        │  │
│  │  │  (First-Party)  │  │                 │  │                 │        │  │
│  │  │                 │  │  POST /tool     │  │  POST /tool     │        │  │
│  │  │  - Mastra Agent │  │                 │  │                 │        │  │
│  │  │  - LLM calls    │  │  Tools:         │  │  Tools:         │        │  │
│  │  │  - Conv history │  │  - play_song    │  │  - search       │        │  │
│  │  │  - Tool calling │  │  - pause        │  │  - bookmark     │        │  │
│  │  │                 │  │                 │  │                 │        │  │
│  │  │  Uses Cloud's   │  └─────────────────┘  └─────────────────┘        │  │
│  │  │  Tool Registry  │                                                   │  │
│  │  │  to get tools   │                                                   │  │
│  │  └─────────────────┘                                                   │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### Tool Name Format

Tools are namespaced using a **colon separator**: `packageName:toolName`

```
com.example.reminder:add_reminder
com.example.reminder:list_reminders
com.music.player:play_song
```

**Why colon?**
- Package names contain dots (e.g., `com.example.app`)
- Tool names should not contain colons (validated)
- Single split on `:` cleanly separates package from tool
- Example: `"com.example.app:add_reminder".split(":")` → `["com.example.app", "add_reminder"]`

### Hardware-Aware Tool Filtering

Tools are **filtered by hardware compatibility** at the app level:

1. **Hardware requirements are defined on the App**, not individual tools
2. When requesting tools, we check each app's `hardwareRequirements` against the connected glasses' `Capabilities`
3. If an app requires hardware the glasses don't have (e.g., camera), **all of that app's tools are excluded**
4. This uses the existing `HardwareCompatibilityService.checkCompatibility()` static method

```
User's Glasses: Even Realities G1
├── hasDisplay: true
├── hasCamera: false
├── hasMicrophone: true
└── hasSpeaker: true

App Filtering:
├── Reminder App (requires: nothing)        → ✅ Include all tools
├── Photo App (requires: camera)            → ❌ Exclude all tools
├── Music App (requires: speaker)           → ✅ Include all tools
└── AR Navigation (requires: camera, GPS)   → ❌ Exclude all tools
```

This is cleaner than per-tool hardware flags because:
- Hardware requirements are already defined at the app level
- An app's tools are useless if the app can't run on the device
- No redundant configuration

### Auto-Activation for Tool Calls

When a tool is called, the app is **automatically started** if not already running:

1. Tool call comes in for `com.example.reminder:add_reminder`
2. ToolExecutor checks if `com.example.reminder` is running
3. If not running → `AppManager.startApp("com.example.reminder")`
4. **Wait for app to connect** (poll with timeout)
5. Forward tool call to app's `/tool` endpoint
6. App now has full session access (display, audio, etc.)

No special flags needed. If a tool is called, the app gets activated.

**Cleanup Policy for Tool-Activated Apps:**
- If tool execution **succeeds**: App stays running (user may interact with it)
- If tool execution **fails** but app connected: App stays running (already paid startup cost)
- If app **never connected** (timeout): No cleanup needed (app didn't start)

Rationale: Starting an app is expensive. Once started, keep it running for the session duration. The AppManager's normal lifecycle will handle stopping inactive apps.

### User-Based Authentication

The tool endpoints require a valid user ID:

```typescript
// Request
POST /api/tools/execute
Headers:
  X-User-Id: <userId>
  Content-Type: application/json
Body:
  { name: "com.app:tool_name", arguments: {...} }
```

The user ID is validated against active sessions using `UserSession.getById(userId)`. This ensures:
- Only authenticated users can execute tools
- Tool calls are associated with the correct user/device context
- Apps receive proper session context when tools are executed

**Note:** The current architecture uses `userId` as the session key. Session-based auth (with separate sessionId) can be a future enhancement if needed.

### Tool Registration Flow

Tools are registered via the **Developer Console**, not at runtime:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Tool Registration Flow                        │
│                                                                 │
│  Developer Console                                              │
│       │                                                         │
│       ▼                                                         │
│  Developer defines tools in app config                          │
│  (name, description, inputSchema, activationPhrases)            │
│       │                                                         │
│       ▼                                                         │
│  POST /api/apps/:packageName/tools                              │
│       │                                                         │
│       ▼                                                         │
│  Cloud validates and stores in MongoDB                          │
│  (App.tools field)                                              │
│       │                                                         │
│       ▼                                                         │
│  ToolRegistryService reads from DB at runtime                   │
│  when Mentra AI (or other apps) request available tools         │
└─────────────────────────────────────────────────────────────────┘
```

Tools are **static configuration**, not dynamic. This means:
- Tools don't change at runtime
- No WebSocket negotiation needed for tool discovery
- Developer Console is the source of truth
- Changes require app update/resubmission

---

## Component Design

### 1. MCP Tool Schema (SDK Types)

Replace the current `ToolSchema` with MCP-compatible format:

```typescript
// packages/sdk/src/types/tools.ts

/**
 * MCP-compatible tool definition
 * See: https://modelcontextprotocol.io/docs/concepts/tools
 */
export interface MCPToolDefinition {
  /**
   * Tool name (local to the app, without package prefix)
   * The full name with package prefix is constructed by the registry
   * Example: "add_reminder" (becomes "com.example.app:add_reminder")
   */
  name: string

  /** Human-readable description for the LLM */
  description: string

  /** JSON Schema for input parameters */
  inputSchema: {
    type: "object"
    properties: Record<string, JSONSchemaProperty>
    required?: string[]
  }

  /** MentraOS extensions (not part of MCP spec) */
  mentraExtensions?: {
    /** Voice activation phrases (e.g., "remind me", "set a reminder") */
    activationPhrases?: string[]

    /** Tool category for organization */
    category?: "productivity" | "media" | "communication" | "utility" | "other"
  }
}

// NOTE: Hardware requirements (display, camera, etc.) are defined at the APP level,
// not the tool level. Tools inherit their app's hardware requirements.
// See: AppI.hardwareRequirements and HardwareCompatibilityService

/** JSON Schema property definition */
export interface JSONSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object"
  description: string
  enum?: (string | number)[]
  default?: unknown
  items?: JSONSchemaProperty // For arrays
  properties?: Record<string, JSONSchemaProperty> // For nested objects
  required?: string[] // For nested objects
}

/**
 * Tool execution request (sent to mini-app)
 */
export interface MCPToolCall {
  /** Tool name (local, without package prefix) */
  name: string

  /** Tool arguments matching inputSchema */
  arguments: Record<string, unknown>

  /** Execution context */
  context: {
    userId: string
    timestamp: string

    /** If app was activated specifically for this tool call */
    activatedForTool: boolean
  }
}

/**
 * Tool execution response (from mini-app)
 */
export interface MCPToolResult {
  /** Tool execution succeeded */
  success: boolean

  /** Result content (for LLM context) */
  content?: string | object

  /** Error details if failed */
  error?: {
    code: string
    message: string
    retryable?: boolean
  }

  /** MentraOS extensions */
  mentraExtensions?: {
    /**
     * App is handling the response (display/audio).
     * Caller should NOT generate a voice response.
     *
     * Use case: Tool displays results on glasses, user doesn't need
     * Mentra AI to read them back.
     */
    suppressVoiceResponse?: boolean

    /** Suggested follow-up actions */
    suggestedFollowUps?: string[]
  }
}
```

### Schema Migration

When migrating from old `ToolSchema` to new `MCPToolDefinition`:

```typescript
// Migration: ToolSchema → MCPToolDefinition
function migrateToolSchema(oldTool: ToolSchema): MCPToolDefinition {
  return {
    name: oldTool.id,  // "id" becomes "name"
    description: oldTool.description,
    inputSchema: {
      type: "object",
      properties: convertParameters(oldTool.parameters || {}),
      required: extractRequired(oldTool.parameters || {}),
    },
    mentraExtensions: {
      activationPhrases: oldTool.activationPhrases,
    },
  }
}

function convertParameters(
  params: Record<string, ToolParameterSchema>
): Record<string, JSONSchemaProperty> {
  const result: Record<string, JSONSchemaProperty> = {}
  for (const [key, param] of Object.entries(params)) {
    result[key] = {
      type: param.type,
      description: param.description,
      enum: param.enum,
    }
  }
  return result
}

function extractRequired(params: Record<string, ToolParameterSchema>): string[] {
  return Object.entries(params)
    .filter(([_, param]) => param.required)
    .map(([key, _]) => key)
}
```

### 2. Tool Registry Service

```typescript
// packages/cloud/src/services/tools/ToolRegistryService.ts

import { MCPToolDefinition } from "@mentra/sdk"
import { Capabilities } from "@mentra/types"
import { HardwareCompatibilityService } from "../session/HardwareCompatibilityService"
import { User } from "../../models/user.model"
import App from "../../models/app.model"
import { Logger } from "pino"

/**
 * Centralized registry of all tools from all installed apps.
 *
 * This is a READ-ONLY service - tools are registered via Developer Console
 * and stored in MongoDB. This service aggregates and filters them at runtime.
 *
 * Performance Note:
 * Current implementation queries DB per request. For production scale:
 * - Cache user's installed apps (invalidate on install/uninstall)
 * - Cache app tool definitions (invalidate on app update)
 * - Consider Redis for distributed cache
 *
 * MVP: Direct DB queries are acceptable (<100ms typical)
 */
export class ToolRegistryService {
  private logger: Logger

  constructor(logger: Logger) {
    this.logger = logger.child({ service: "ToolRegistryService" })
  }

  /**
   * Get all tools available to a user, filtered by device capabilities.
   * Only returns tools from apps compatible with the connected glasses.
   */
  async getToolsForUser(
    userId: string,
    deviceCapabilities: Capabilities | null
  ): Promise<MCPToolDefinition[]> {
    // 1. Get user's installed apps from DB
    const user = await User.findOne({ email: userId })
    const installedApps = user?.installedApps || []

    // 2. Fetch tool definitions for each COMPATIBLE app
    const allTools: MCPToolDefinition[] = []

    for (const { packageName } of installedApps) {
      const app = await App.findOne({ packageName })
      if (!app?.tools?.length) continue

      // 3. Check hardware compatibility using static method
      const compatibility = HardwareCompatibilityService.checkCompatibility(
        app,
        deviceCapabilities
      )

      if (!compatibility.isCompatible) {
        this.logger.debug(
          { packageName, missingHardware: compatibility.missingRequired },
          "Skipping tools from incompatible app"
        )
        continue
      }

      // 4. Namespace tools with package name using colon separator
      for (const tool of app.tools) {
        allTools.push({
          ...tool,
          name: `${packageName}:${tool.name}`,
        })
      }
    }

    return allTools
  }

  /**
   * Get tool definition by full name (packageName:toolName)
   */
  async getToolByFullName(fullToolName: string): Promise<{
    tool: MCPToolDefinition
    packageName: string
    app: AppI
  } | null> {
    const parsed = this.parseToolName(fullToolName)
    if (!parsed) return null

    const { packageName, localToolName } = parsed

    const app = await App.findOne({ packageName })
    if (!app?.tools) return null

    const tool = app.tools.find((t) => t.name === localToolName)
    if (!tool) return null

    return {
      tool: { ...tool, name: fullToolName },
      packageName,
      app,
    }
  }

  /**
   * Parse a full tool name into package and local parts.
   * Uses colon as separator: "com.example.app:add_reminder"
   */
  parseToolName(fullName: string): { packageName: string; localToolName: string } | null {
    const colonIndex = fullName.indexOf(":")
    if (colonIndex === -1) {
      this.logger.warn({ fullName }, "Invalid tool name format - missing colon separator")
      return null
    }

    const packageName = fullName.substring(0, colonIndex)
    const localToolName = fullName.substring(colonIndex + 1)

    if (!packageName || !localToolName) {
      this.logger.warn({ fullName }, "Invalid tool name format - empty package or tool name")
      return null
    }

    return { packageName, localToolName }
  }
}
```

### 3. Tool Executor Service

```typescript
// packages/cloud/src/services/tools/ToolExecutorService.ts

import { MCPToolCall, MCPToolResult } from "@mentra/sdk"
import { Logger } from "pino"
import { ToolRegistryService } from "./ToolRegistryService"
import { AppManager } from "../session/AppManager"
import UserSession from "../session/UserSession"

const TOOL_EXECUTION_TIMEOUT_MS = 30000  // 30 seconds
const APP_ACTIVATION_TIMEOUT_MS = 10000  // 10 seconds
const APP_ACTIVATION_POLL_INTERVAL_MS = 200  // 200ms

/**
 * Executes tool calls by routing to appropriate mini-apps.
 * Handles app activation, connection waiting, and error handling.
 */
export class ToolExecutorService {
  constructor(
    private toolRegistry: ToolRegistryService,
    private logger: Logger,
  ) {
    this.logger = logger.child({ service: "ToolExecutorService" })
  }

  /**
   * Execute a tool call
   */
  async execute(
    toolCall: MCPToolCall,
    userSession: UserSession
  ): Promise<MCPToolResult> {
    const startTime = Date.now()

    try {
      // 1. Parse and validate tool name
      const parsed = this.toolRegistry.parseToolName(toolCall.name)
      if (!parsed) {
        return {
          success: false,
          error: {
            code: "INVALID_TOOL_NAME",
            message: `Invalid tool name format: ${toolCall.name}. Expected format: packageName:toolName`,
            retryable: false,
          },
        }
      }

      const { packageName, localToolName } = parsed

      // 2. Get tool definition and app
      const toolInfo = await this.toolRegistry.getToolByFullName(toolCall.name)
      if (!toolInfo) {
        return {
          success: false,
          error: { code: "TOOL_NOT_FOUND", message: `Tool ${toolCall.name} not found` },
        }
      }

      // 3. Validate arguments against schema
      const validationResult = this.validateArguments(
        toolCall.arguments,
        toolInfo.tool.inputSchema
      )
      if (!validationResult.valid) {
        return {
          success: false,
          error: {
            code: "INVALID_ARGUMENTS",
            message: validationResult.error!,
            retryable: false,
          },
        }
      }

      // 4. Ensure app is running and connected
      const activatedForTool = await this.ensureAppReady(packageName, userSession)
      toolCall.context.activatedForTool = activatedForTool

      // 5. Get app's public URL
      if (!toolInfo.app.publicUrl) {
        return {
          success: false,
          error: { code: "APP_NOT_AVAILABLE", message: `App ${packageName} has no public URL` },
        }
      }

      // 6. Execute HTTP request to app
      const result = await this.executeHttpRequest(
        toolInfo.app.publicUrl,
        toolInfo.app.hashedApiKey,  // For authentication
        {
          ...toolCall,
          name: localToolName, // Send local name, not namespaced
        }
      )

      // 7. Log execution
      this.logger.info(
        {
          tool: toolCall.name,
          userId: toolCall.context.userId,
          duration: Date.now() - startTime,
          success: result.success,
        },
        "Tool executed",
      )

      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error"
      this.logger.error({ error, tool: toolCall.name }, "Tool execution failed")

      // Determine if error is retryable
      const isTimeout = errorMessage.includes("timeout") || errorMessage.includes("ETIMEDOUT")
      const isNetworkError = errorMessage.includes("ECONNREFUSED") || errorMessage.includes("ENOTFOUND")

      return {
        success: false,
        error: {
          code: isTimeout ? "TIMEOUT" : isNetworkError ? "NETWORK_ERROR" : "EXECUTION_ERROR",
          message: errorMessage,
          retryable: isTimeout || isNetworkError,
        },
      }
    }
  }

  /**
   * Ensure app is activated and connected.
   * Returns true if app was activated for this tool call, false if already running.
   */
  private async ensureAppReady(
    packageName: string,
    userSession: UserSession
  ): Promise<boolean> {
    const appSession = userSession.appManager.getAppSession(packageName)

    // If app is already running with active connection, we're good
    // Use isRunning getter which checks state === RUNNING
    if (appSession?.isRunning) {
      return false
    }

    // Start the app
    this.logger.info({ packageName }, "Activating app for tool call")

    const result = await userSession.appManager.startApp(packageName)
    if (!result.success) {
      throw new Error(`Failed to activate app: ${result.error?.message}`)
    }

    // Wait for app to connect with timeout
    await this.waitForAppConnection(packageName, userSession)

    return true // Was activated for this tool call
  }

  /**
   * Poll until app is connected or timeout expires.
   */
  private async waitForAppConnection(
    packageName: string,
    userSession: UserSession
  ): Promise<void> {
    const startTime = Date.now()

    while (Date.now() - startTime < APP_ACTIVATION_TIMEOUT_MS) {
      const appSession = userSession.appManager.getAppSession(packageName)

      // Use isRunning getter to check connection state
      if (appSession?.isRunning) {
        this.logger.debug({ packageName }, "App connected")
        return
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, APP_ACTIVATION_POLL_INTERVAL_MS))
    }

    throw new Error(
      `App ${packageName} did not connect within ${APP_ACTIVATION_TIMEOUT_MS}ms`
    )
  }

  /**
   * Execute HTTP request to app's /tool endpoint
   */
  private async executeHttpRequest(
    publicUrl: string,
    hashedApiKey: string | undefined,
    toolCall: MCPToolCall
  ): Promise<MCPToolResult> {
    const webhookUrl = `${publicUrl}/tool`

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }

      // Add authentication header if available (matches current webhook pattern)
      if (hashedApiKey) {
        headers["X-App-API-Key"] = hashedApiKey
      }

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(toolCall),
        signal: AbortSignal.timeout(TOOL_EXECUTION_TIMEOUT_MS),
      })

      if (!response.ok) {
        return {
          success: false,
          error: {
            code: "HTTP_ERROR",
            message: `HTTP ${response.status}: ${response.statusText}`,
            retryable: response.status >= 500,
          },
        }
      }

      return (await response.json()) as MCPToolResult
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`Tool execution timeout after ${TOOL_EXECUTION_TIMEOUT_MS}ms`)
      }
      throw error
    }
  }

  private validateArguments(
    args: Record<string, unknown>,
    schema: MCPToolDefinition["inputSchema"],
  ): { valid: boolean; error?: string } {
    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in args)) {
          return { valid: false, error: `Missing required field: ${field}` }
        }
      }
    }

    // Type validation (basic - could use Ajv for full JSON Schema validation)
    for (const [key, value] of Object.entries(args)) {
      const propSchema = schema.properties[key]
      if (!propSchema) continue // Allow extra fields

      const actualType = Array.isArray(value) ? "array" : typeof value
      if (propSchema.type !== actualType) {
        // Allow integer to match number
        if (propSchema.type === "integer" && actualType === "number") continue
        return {
          valid: false,
          error: `Field "${key}" expected ${propSchema.type}, got ${actualType}`,
        }
      }
    }

    return { valid: true }
  }
}
```

### 4. Tool Routes (API Endpoints)

```typescript
// packages/cloud/src/api/hono/routes/tools.routes.ts

import { Hono } from "hono"
import { MCPToolCall } from "@mentra/sdk"
import UserSession from "../../../services/session/UserSession"
import { ToolRegistryService } from "../../../services/tools/ToolRegistryService"
import { ToolExecutorService } from "../../../services/tools/ToolExecutorService"
import { logger as rootLogger } from "../../../services/logging/pino-logger"

const logger = rootLogger.child({ service: "tools.routes" })
const toolRegistry = new ToolRegistryService(logger)
const toolExecutor = new ToolExecutorService(toolRegistry, logger)

const toolsRouter = new Hono()

/**
 * Get available tools for the current user.
 * Filters by hardware compatibility automatically.
 */
toolsRouter.get("/", async (c) => {
  const userId = c.req.header("X-User-Id")

  if (!userId) {
    return c.json({ error: "Missing X-User-Id header" }, 401)
  }

  // Get user session using static method (userId is the key)
  const userSession = UserSession.getById(userId)
  if (!userSession) {
    return c.json({ error: "No active session for user" }, 401)
  }

  // Get device capabilities (may be null if no glasses connected)
  const deviceCapabilities = userSession.deviceManager.getCapabilities()

  const tools = await toolRegistry.getToolsForUser(userId, deviceCapabilities)

  return c.json({ tools })
})

/**
 * Execute a tool call.
 * Requires valid user session, auto-activates app if needed.
 */
toolsRouter.post("/execute", async (c) => {
  const userId = c.req.header("X-User-Id")

  if (!userId) {
    return c.json({ error: "Missing X-User-Id header" }, 401)
  }

  // Get user session using static method
  const userSession = UserSession.getById(userId)
  if (!userSession) {
    return c.json({ error: "No active session for user" }, 401)
  }

  const body = await c.req.json()

  // Validate request body
  if (!body.name || typeof body.name !== "string") {
    return c.json({
      success: false,
      error: { code: "INVALID_REQUEST", message: "Missing or invalid tool name" },
    }, 400)
  }

  const toolCall: MCPToolCall = {
    name: body.name,
    arguments: body.arguments || {},
    context: {
      userId: userId,
      timestamp: new Date().toISOString(),
      activatedForTool: false,
    },
  }

  const result = await toolExecutor.execute(toolCall, userSession)

  // Return appropriate status code based on result
  const status = result.success ? 200 :
    result.error?.code === "TOOL_NOT_FOUND" ? 404 :
    result.error?.code === "INVALID_ARGUMENTS" ? 400 : 500

  return c.json(result, status)
})

export { toolsRouter }
```

### 5. SDK Changes for Mini-Apps

```typescript
// packages/sdk/src/app/server/tool-handler.ts

import { MCPToolCall, MCPToolResult, MCPToolDefinition } from "../../types/tools"

/**
 * Tool handler function type
 */
export type ToolHandler<TArgs = Record<string, unknown>> = (
  args: TArgs,
  context: MCPToolCall["context"]
) => Promise<MCPToolResult>

/**
 * Create a tool definition with handler for a mini-app.
 *
 * @example
 * ```typescript
 * const addReminder = createTool({
 *   name: "add_reminder",
 *   description: "Add a reminder for the user",
 *   parameters: {
 *     text: { type: "string", description: "What to remind about" },
 *     time: { type: "string", description: "When to remind (ISO 8601)" },
 *   },
 *   required: ["text"],
 *   activationPhrases: ["remind me", "set a reminder"],
 *
 *   handler: async (args, context) => {
 *     const reminder = await db.reminders.create({
 *       userId: context.userId,
 *       text: args.text,
 *       time: args.time ? new Date(args.time) : null,
 *     })
 *
 *     return {
 *       success: true,
 *       content: `Reminder added: "${args.text}"`,
 *     }
 *   },
 * })
 *
 * // Register with app server
 * appServer.registerTool(addReminder)
 * ```
 */
export function createTool<TArgs extends Record<string, unknown>>(config: {
  /** Tool name (local, without package prefix) */
  name: string
  description: string
  parameters: MCPToolDefinition["inputSchema"]["properties"]
  required?: string[]
  activationPhrases?: string[]
  category?: "productivity" | "media" | "communication" | "utility" | "other"
  handler: ToolHandler<TArgs>
}): {
  definition: MCPToolDefinition
  handler: (call: MCPToolCall) => Promise<MCPToolResult>
} {
  // Validate tool name doesn't contain colon (reserved for namespace separator)
  if (config.name.includes(":")) {
    throw new Error(`Tool name "${config.name}" cannot contain colon character`)
  }

  return {
    definition: {
      name: config.name,
      description: config.description,
      inputSchema: {
        type: "object",
        properties: config.parameters,
        required: config.required,
      },
      mentraExtensions: {
        activationPhrases: config.activationPhrases,
        category: config.category,
      },
    },
    handler: async (call: MCPToolCall): Promise<MCPToolResult> => {
      try {
        return await config.handler(call.arguments as TArgs, call.context)
      } catch (error) {
        return {
          success: false,
          error: {
            code: "HANDLER_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
            retryable: false,
          },
        }
      }
    },
  }
}
```

### 6. Updated AppServer in SDK

```typescript
// packages/sdk/src/app/server/index.ts (partial update)

import { MCPToolDefinition, MCPToolCall, MCPToolResult } from "../../types/tools"

export class AppServer {
  private tools: Map<string, (call: MCPToolCall) => Promise<MCPToolResult>> = new Map()
  private toolDefinitions: MCPToolDefinition[] = []

  /**
   * Register a tool with handler
   */
  registerTool(tool: {
    definition: MCPToolDefinition
    handler: (call: MCPToolCall) => Promise<MCPToolResult>
  }): void {
    // Validate name doesn't have colon
    if (tool.definition.name.includes(":")) {
      throw new Error(`Tool name cannot contain ":". Got: ${tool.definition.name}`)
    }

    this.tools.set(tool.definition.name, tool.handler)
    this.toolDefinitions.push(tool.definition)
    this.logger.info({ tool: tool.definition.name }, "Tool registered")
  }

  /**
   * Get all tool definitions for registration with cloud.
   * These are sent to Developer Console for storage.
   */
  getToolDefinitions(): MCPToolDefinition[] {
    return this.toolDefinitions
  }

  /**
   * Setup the /tool endpoint
   */
  private setupToolEndpoint(): void {
    this.app.post("/tool", async (req, res) => {
      const toolCall = req.body as MCPToolCall

      this.logger.info({ tool: toolCall.name }, "Received tool call")

      // Find handler
      const handler = this.tools.get(toolCall.name)
      if (!handler) {
        res.status(404).json({
          success: false,
          error: { code: "TOOL_NOT_FOUND", message: `Tool ${toolCall.name} not found` },
        } as MCPToolResult)
        return
      }

      // Execute with error handling
      try {
        const result = await handler(toolCall)
        res.json(result)
      } catch (error) {
        this.logger.error({ error, tool: toolCall.name }, "Tool execution error")
        res.status(500).json({
          success: false,
          error: {
            code: "EXECUTION_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        } as MCPToolResult)
      }
    })
  }
}
```

---

## Mentra AI Mini-App Integration

The Mentra AI mini-app is a **first-party app** that uses the MentraOS SDK. It:

1. Subscribes to transcription events from the cloud
2. Maintains conversation history (in-memory or persisted)
3. Uses Mastra framework to run the LLM agent
4. Calls cloud's Tool Registry to get available tools
5. Executes tools via cloud's Tool Executor
6. Displays responses on glasses and/or speaks via TTS

```typescript
// Conceptual structure of Mentra AI app
// NOTE: This uses Mastra's createTool, not the SDK's createTool helper

import { Agent } from "@mastra/core"
import { createTool as createMastraTool } from "@mastra/core"

class MentraAIApp extends AppServer {
  private agent: Agent
  private conversationHistory: Map<string, ConversationMessage[]> = new Map()

  async onTranscription(session: AppSession, transcript: TranscriptionResult) {
    if (!transcript.isFinal) return
    if (!this.shouldRespond(transcript)) return

    const userId = session.userId
    const history = this.getHistory(userId)

    // Get tools from cloud (hardware-filtered)
    // Note: session.userId is available from the SDK's AppSession context
    const tools = await this.fetchTools(userId)

    // Run Mastra agent with tools converted to Mastra format
    const response = await this.agent.generate(transcript.text, {
      tools: tools.map(t => this.toMastraTool(t, userId)),
      context: { history },
    })

    // Update history
    history.push({ role: "user", content: transcript.text })
    history.push({ role: "assistant", content: response.text })
    this.trimHistory(userId)

    // Display/speak response (unless tool already handled it)
    if (!response.suppressVoiceResponse) {
      await session.layouts.showTextWall(response.text)
      await session.tts.speak(response.text)
    }
  }

  private async fetchTools(userId: string): Promise<MCPToolDefinition[]> {
    const response = await fetch(`${CLOUD_URL}/api/tools`, {
      headers: { "X-User-Id": userId },
    })
    const data = await response.json()
    return data.tools
  }

  /**
   * Convert MCP tool definition to Mastra tool format
   * NOTE: This is Mastra's createTool, not the SDK's createTool helper
   */
  private toMastraTool(toolDef: MCPToolDefinition, userId: string) {
    return createMastraTool({
      id: toolDef.name,
      description: toolDef.description,
      inputSchema: toolDef.inputSchema,
      execute: async ({ context }) => {
        // Execute via cloud's tool executor
        const result = await fetch(`${CLOUD_URL}/api/tools/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Id": userId,
          },
          body: JSON.stringify({
            name: toolDef.name,
            arguments: context,
          }),
        })
        return result.json()
      },
    })
  }
}
```

---

## Migration Path

### Phase 1: Schema Migration

1. Add new `MCPToolDefinition` types to SDK
2. Create migration script for existing tool definitions in DB (see Schema Migration section)
3. Update Developer Console to use new schema
4. Keep old endpoints working temporarily

### Phase 2: Tool Services

1. Implement `ToolRegistryService`
2. Implement `ToolExecutorService`
3. Add user-based authentication (`X-User-Id` header)
4. Add wait-for-connection logic
5. Deploy new API endpoints

### Phase 3: Mentra AI Integration

1. Add tool calling to existing Mentra AI mini-app
2. Add Mastra as dependency to the app
3. Implement tool fetching from cloud's registry
4. Implement tool execution via cloud's executor
5. Test with existing apps' tools

### Phase 4: Cleanup

1. Remove old LangChain code from cloud
2. Remove old tool routes
3. Update all documentation
4. Update SDK examples

---

## API Changes Summary

### New Endpoints

- `GET /api/tools` - Get available tools (requires X-User-Id header)
- `POST /api/tools/execute` - Execute a tool (requires X-User-Id header)

### Removed Endpoints

- `GET /api/tools/apps/:packageName/tools` - replaced by registry
- `GET /api/tools/users/:userId/tools` - replaced by registry
- `POST /api/tools/apps/:packageName/tool` - replaced by executor

### SDK Changes

- New `MCPToolDefinition` type (replaces `ToolSchema`)
- New `MCPToolCall` type
- New `MCPToolResult` type
- New `createTool()` helper function
- Updated `AppServer.registerTool()` method

---

## Open Questions

1. **Multi-language support**: How do activation phrases work across languages?

2. **Tool permissions**: Should users be able to disable specific tools per-app?

3. **Rate limiting**: Per-user rate limits on tool calls?

4. **Billing/usage tracking**: How to track tool usage for potential monetization?

5. **Mentra AI app storage**: Should conversation history persist across sessions? If so, where? (Device? Cloud DB for Mentra AI app specifically?)

---

## Dependencies

### New Packages (Mentra AI App)

```json
{
  "@mastra/core": "^0.x.x",
  "ajv": "^8.x.x"
}
```

### Removed Packages (Cloud)

```json
{
  "langchain": "remove",
  "@langchain/core": "remove",
  "@langchain/openai": "remove"
}
```

Note: Mastra is added to the Mentra AI mini-app, not to the cloud core. The cloud remains a thin, stateless routing layer.
