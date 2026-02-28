---
sidebar_position: 5
title: Tool Types
---

# Tool Types

This page documents the interfaces and types used for App tools integration with Mira AI.

For a complete guide on implementing App tools, see [AI Tools](/tools).

## ToolSchema

Interface defining the structure of a tool that a App can expose to Mira AI.

```typescript
interface ToolSchema {
  /** Unique identifier for the tool */
  id: string

  /** Human-readable description of what the tool does */
  description: string

  /** Optional phrases that might trigger this tool (helps Mira recognize when to use it) */
  activationPhrases?: string[]

  /** Definition of parameters this tool accepts */
  parameters?: Record<string, ToolParameterSchema>
}
```

## ToolParameterSchema

Interface defining the structure of parameters that a tool accepts.

```typescript
interface ToolParameterSchema {
  /** Data type of the parameter */
  type: "string" | "number" | "boolean"

  /** Human-readable description of what the parameter is for */
  description: string

  /** Optional list of allowed values for string parameters */
  enum?: string[]

  /** Whether this parameter is required */
  required?: boolean
}
```

## ToolCall

Interface representing a call to a App tool from Mira AI.

```typescript
interface ToolCall {
  /** ID of the tool being called */
  toolId: string

  /** Parameter values for this specific call */
  toolParameters: Record<string, string | number | boolean>

  /** When the tool call was made */
  timestamp: Date

  /** ID of the user who triggered the tool call */
  userId: string

  /** The active session for the user who triggered the tool call, if the user is currently running this app */
  activeSession: AppSession | null
}
```

## GIVE_APP_CONTROL_OF_TOOL_RESPONSE

The string `GIVE_APP_CONTROL_OF_TOOL_RESPONSE` is a special string that can be returned by your app to indicate that Mira should not respond to the user, and your app will respond directly.

```typescript
import {GIVE_APP_CONTROL_OF_TOOL_RESPONSE} from "@mentra/sdk"

export class TodoAppServer extends AppServer {
  protected async onToolCall(toolCall: ToolCall): Promise<string | undefined> {
    const {toolId, activeSession} = toolCall

    // Handle different tool calls
    switch (toolId) {
      case "get_todos": {
        const todoList = userTodos
          .map(todo => `- ${todo.completed ? "✓" : "○"} ${todo.text}${todo.dueDate ? ` (due ${todo.dueDate})` : ""}`)
          .join("\n")

        if (activeSession) {
          // if the user is currently using the app, display the todo list in the app directly
          activeSession.layouts.showTextWall(todoList)
          return GIVE_APP_CONTROL_OF_TOOL_RESPONSE
        } else {
          // if the user is not currently using the app, return the todo list to Mira for Mira to relay
          return `Your todo list:\n${todoList}`
        }
      }
    }
  }
}
```

## Tool Configuration

Tools are defined in the devloper console. Go to [console.mentra.glass/apps](https://console.mentra.glass/apps) and edit your App, then look for the "AI Tools" section.

![AI Tools Section](/img/tool-editor.png)

Each tool definition has:

- **`id`**: Unique identifier for the tool
- **`description`**: Human/AI-readable description of what the tool does
- **`activationPhrases`**: Optional comma-separated list of phrases that might trigger this tool (although Mira may also trigger tools based on the context of the conversation)
- **`parameters`**: Optional list of parameters the tool accepts

### Parameter Properties

Each parameter definition has:

- **`type`**: Data type of the parameter - `"string"`, `"number"`, or `"boolean"`
- **`description`**: Human/AI-readable description of the parameter
- **`required`**: Whether the parameter is required
- **`enum`**: Optional comma-separated list of allowed values for string parameters (if specified, Mira will choose one of these values)
