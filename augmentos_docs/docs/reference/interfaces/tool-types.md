---
sidebar_position: 5
title: Tool Types
---

# Tool Types

This page documents the interfaces and types used for TPA tools integration with Mira AI.

For a complete guide on implementing TPA tools, see [AI Tools](/tools).

## ToolSchema

Interface defining the structure of a tool that a TPA can expose to Mira AI.

```typescript
interface ToolSchema {
  /** Unique identifier for the tool */
  id: string;

  /** Human-readable description of what the tool does */
  description: string;

  /** Optional phrases that might trigger this tool (helps Mira recognize when to use it) */
  activationPhrases?: string[];

  /** Definition of parameters this tool accepts */
  parameters?: Record<string, ToolParameterSchema>;
}
```

## ToolParameterSchema

Interface defining the structure of parameters that a tool accepts.

```typescript
interface ToolParameterSchema {
  /** Data type of the parameter */
  type: 'string' | 'number' | 'boolean';

  /** Human-readable description of what the parameter is for */
  description: string;

  /** Optional list of allowed values for string parameters */
  enum?: string[];

  /** Whether this parameter is required */
  required?: boolean;
}
```

## ToolCall

Interface representing a call to a TPA tool from Mira AI.

```typescript
interface ToolCall {
  /** ID of the tool being called */
  toolId: string;

  /** Parameter values for this specific call */
  toolParameters: Record<string, string | number | boolean>;

  /** When the tool call was made */
  timestamp: Date;

  /** ID of the user who triggered the tool call */
  userId: string;
}
```

## Tool Configuration

Tools are defined in the devloper console.  Go to [console.augmentos.com/apps](https://console.augmentos.com/apps) and edit your TPA, then look for the "AI Tools" section.

![AI Tools Section](/img/tool-editor.png)

Each tool definition has:

* **`id`**: Unique identifier for the tool
* **`description`**: Human/AI-readable description of what the tool does
* **`activationPhrases`**: Optional comma-separated list of phrases that might trigger this tool (although Mira may also trigger tools based on the context of the conversation)
* **`parameters`**: Optional list of parameters the tool accepts

### Parameter Properties

Each parameter definition has:

* **`type`**: Data type of the parameter - `"string"`, `"number"`, or `"boolean"`
* **`description`**: Human/AI-readable description of the parameter
* **`required`**: Whether the parameter is required
* **`enum`**: Optional comma-separated list of allowed values for string parameters (if specified, Mira will choose one of these values)