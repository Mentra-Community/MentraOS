# AI Tools

AugmentOS provides a powerful way for apps to extend Mira AI's capabilities through custom tools. These tools allow Mira to take actions within your app, such as creating content, fetching data, or controlling features - all through natural language conversations with users.

```typescript
// Example of handling a tool call in your app
protected async onToolCall(toolCall: ToolCall): Promise<string | undefined> {
  if (toolCall.toolId === "add_todo") {
    const todoItem = toolCall.toolParameters.todo_item as string;
    const dueDate = toolCall.toolParameters.due_date as string | undefined;

    // Add the todo item to your storage
    const newTodo = await this.todoService.addTodo(toolCall.userId, todoItem, dueDate);

    return `✅ Added: "${todoItem}"${dueDate ? ` due ${dueDate}` : ''}`;
  }

  return undefined;
}
```

## What Are App Tools?

App tools are functions that your application exposes to Mira AI. When a user asks Mira to perform an action that matches one of your tools, Mira will:

1. Identify the relevant tool
2. Extract necessary parameters from the user's request
3. Call your app with these parameters
4. Return your response to the user

This creates a seamless experience where users interact with your app through natural conversations with Mira.

Tool calls don't happen in the context of a session, and your app does not need to be running to respond to a tool call.  Your app should respond with a text string that Mira's AI will use to formulate a response.

For detailed reference on the interfaces involved, see [Tool Types](/reference/interfaces/tool-types).

## Defining Your Tools

Tools are defined in the devloper console.  Go to [console.augmentos.org/apps](https://console.augmentos.org/apps) and edit your app, then look for the "AI Tools" section.

![AI Tools Section](/img/tool-editor.png)

Each tool definition has:

* **`id`**: Unique identifier for the tool
* **`description`**: Human/AI-readable description of what the tool does
* **`activationPhrases`**: Optional comma-separated list of phrases that might trigger this tool (although Mira may also trigger tools based on the context of the conversation)
* **`parameters`**: Optional list of parameters the tool accepts

For the full interface definition, see [ToolSchema](/reference/interfaces/tool-types#toolschema).

### Parameter Properties

Each parameter definition has:

* **`type`**: Data type of the parameter - `"string"`, `"number"`, or `"boolean"`
* **`description`**: Human/AI-readable description of the parameter
* **`required`**: Whether the parameter is required
* **`enum`**: Optional comma-separated list of allowed values for string parameters (if specified, Mira will choose one of these values)

For the full interface definition, see [ToolParameterSchema](/reference/interfaces/tool-types#toolparameterschema).

## Implementing Tool Handling

### 1. Override onToolCall

In your app server, override the [`onToolCall`](/reference/app-server#ontoolcall-protected) method to handle incoming [tool calls](/reference/interfaces/tool-types#toolcall):

```typescript
import { AppServer, ToolCall } from '@augmentos/sdk';

export class MyAppServer extends AppServer {
  protected async onToolCall(toolCall: ToolCall): Promise<string | undefined> {
    console.log(`Tool called: ${toolCall.toolId}`);
    console.log(`User: ${toolCall.userId}`);
    console.log(`Parameters: ${JSON.stringify(toolCall.toolParameters)}`);

    // Handle specific tools based on toolId
    switch (toolCall.toolId) {
      case 'my_tool':
        return this.handleMyTool(toolCall);
      case 'another_tool':
        return this.handleAnotherTool(toolCall);
      default:
        return undefined;
    }
  }

  private async handleMyTool(toolCall: ToolCall): Promise<string> {
    // Implement your tool-specific logic here
    // ...
    return "Tool result message";
  }
}
```

### 2. Return Values

Your `onToolCall` method should return a string that will be passed to Mira's AI to formulate a response.

## Common Tool Patterns

### CRUD Operations

```json
{
  "tools": [
    {
      "id": "create_item",
      "description": "Create a new item",
      "parameters": {
        "name": {
          "type": "string",
          "description": "Name of the item",
          "required": true
        },
        "category": {
          "type": "string",
          "description": "Category of the item",
          "enum": ["Category1", "Category2", "Category3"]
        }
      }
    },
    {
      "id": "get_items",
      "description": "Get a list of items",
      "parameters": {
        "limit": {
          "type": "number",
          "description": "Maximum number of items to return"
        },
        "category": {
          "type": "string",
          "description": "Filter by category"
        }
      }
    },
    {
      "id": "update_item",
      "description": "Update an existing item",
      "parameters": {
        "id": {
          "type": "string",
          "description": "ID of the item to update",
          "required": true
        },
        "name": {
          "type": "string",
          "description": "New name for the item"
        },
        "category": {
          "type": "string",
          "description": "New category for the item"
        }
      }
    },
    {
      "id": "delete_item",
      "description": "Delete an item",
      "parameters": {
        "id": {
          "type": "string",
          "description": "ID of the item to delete",
          "required": true
        }
      }
    }
  ]
}
```

### Todo List Example

```json
{
  "tools": [
    {
      "id": "add_todo",
      "description": "Add a new to-do item",
      "activationPhrases": ["add a reminder", "create a todo", "remind me to"],
      "parameters": {
        "todo_item": {
          "type": "string",
          "description": "The to-do item text",
          "required": true
        },
        "due_date": {
          "type": "string",
          "description": "Due date in ISO format (YYYY-MM-DD)"
        }
      }
    },
    {
      "id": "get_todos",
      "description": "Get all to-do items",
      "activationPhrases": ["show my todos", "list my reminders"],
      "parameters": {
        "include_completed": {
          "type": "boolean",
          "description": "Whether to include completed items"
        }
      }
    },
    {
      "id": "mark_todo_complete",
      "description": "Mark a to-do item as complete",
      "parameters": {
        "todo_id": {
          "type": "string",
          "description": "ID of the to-do item",
          "required": true
        }
      }
    }
  ]
}
```

## Implementation Example

Here's how to implement a complete todo list app with Mira integration:

```typescript
import { AppServer, ToolCall } from '@augmentos/sdk';

// Simple in-memory todo storage
const todos = new Map<string, Map<string, Todo>>();

interface Todo {
  id: string;
  text: string;
  completed: boolean;
  dueDate?: string;
  createdAt: Date;
}

export class TodoAppServer extends AppServer {
  protected async onToolCall(toolCall: ToolCall): Promise<string | undefined> {
    const { toolId, userId, toolParameters } = toolCall;

    // Initialize user's todo list if it doesn't exist
    if (!todos.has(userId)) {
      todos.set(userId, new Map<string, Todo>());
    }

    // Get user's todo list
    const userTodos = todos.get(userId)!;

    // Handle different tool calls
    switch (toolId) {
      case 'add_todo': {
        const todoText = toolParameters.todo_item as string;
        const dueDate = toolParameters.due_date as string | undefined;

        // Create a new todo
        const id = Date.now().toString();
        const newTodo: Todo = {
          id,
          text: todoText,
          completed: false,
          dueDate,
          createdAt: new Date()
        };

        // Save it
        userTodos.set(id, newTodo);

        return `✅ Added to your list: "${todoText}"${dueDate ? ` due ${dueDate}` : ''}`;
      }

      case 'get_todos': {
        const includeCompleted = toolParameters.include_completed as boolean || false;

        // Filter todos
        const filteredTodos = Array.from(userTodos.values())
          .filter(todo => includeCompleted || !todo.completed)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        if (filteredTodos.length === 0) {
          return "You don't have any todos yet.";
        }

        // Format response
        const todoList = filteredTodos.map(todo =>
          `- ${todo.completed ? '✓' : '○'} ${todo.text}${todo.dueDate ? ` (due ${todo.dueDate})` : ''}`
        ).join('\n');

        return `Your todo list:\n${todoList}`;
      }

      case 'mark_todo_complete': {
        const todoId = toolParameters.todo_id as string;
        const todo = userTodos.get(todoId);

        if (!todo) {
          return "I couldn't find that todo item.";
        }

        // Update todo
        todo.completed = true;
        userTodos.set(todoId, todo);

        return `✓ Marked "${todo.text}" as complete.`;
      }

      case 'mark_todo_incomplete': {
        const todoId = toolParameters.todo_id as string;
        const todo = userTodos.get(todoId);

        if (!todo) {
          return "I couldn't find that todo item.";
        }

        // Update todo
        todo.completed = false;
        userTodos.set(todoId, todo);

        return `○ Marked "${todo.text}" as incomplete.`;
      }

      case 'delete_todo': {
        const todoId = toolParameters.todo_id as string;
        const todo = userTodos.get(todoId);

        if (!todo) {
          return "I couldn't find that todo item.";
        }

        // Delete todo
        userTodos.delete(todoId);

        return `🗑️ Deleted "${todo.text}" from your list.`;
      }

      default:
        return undefined;
    }
  }
}
```

## Tool Call Lifecycle

1. **Tool Call Detection**: Mira AI identifies a tool call based on the tool's activation phrases
2. **Parameter Extraction**: Mira extracts parameters from the user's request
3. **Tool Call Execution**: Mira calls the `/tool` endpoint of your app server with the extracted parameters.  You don't need to handle this manually, the SDK handles this for you.
4. **Your App Handles the Tool Call**: Your overridden `onToolCall` method is called with the tool call details.  You can handle the tool call logic here.
5. **Your App Responds**: Your app responds with a text string that Mira's AI will use to formulate a response.
6. **Mira Responds to the User**: Mira uses your response to formulate a response to the user, or call other tools as needed.  Your response is not necessarily the final response to the user, it is just information the AI uses to formulate a response.

## Related Documentation

* [Tool Types Reference](/reference/interfaces/tool-types) - Detailed type definitions for tools
* [TPA Server - onToolCall](/reference/app-server#ontoolcall-protected) - API reference for the onToolCall method
* [Getting Started with Apps](/getting-started) - Complete guide to building an app