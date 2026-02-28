# API Route Examples - Express vs Bun

This document shows side-by-side comparisons of building API routes in Express vs Bun.

## Table of Contents

- [Simple Public Route](#simple-public-route)
- [Protected Route (Auth Required)](#protected-route-auth-required)
- [Optional Auth Route](#optional-auth-route)
- [Route with Path Parameters](#route-with-path-parameters)
- [Route with POST Body](#route-with-post-body)
- [Route with Custom Headers](#route-with-custom-headers)

---

## Simple Public Route

### Express (in `src/index.ts`)

```typescript
expressApp.get("/api/hello", (req, res) => {
  res.json({
    message: "Hello from Express!",
    timestamp: new Date().toISOString(),
  })
})
```

### Bun (in `src/api/routes.ts`)

```typescript
export const routes = {
  "/api/hello": {
    async GET(req: Request) {
      return Response.json({
        message: "Hello from Bun!",
        timestamp: new Date().toISOString(),
      })
    },
  },
}
```

---

## Protected Route (Auth Required)

### Express (in `src/index.ts`)

```typescript
expressApp.get("/api/profile", (req, res) => {
  const authReq = req as any

  // Auth middleware already ran - check if user is authenticated
  if (!authReq.authUserId) {
    return res.status(401).json({
      error: "Not authenticated",
      message: "Please authenticate via /mentra-auth",
    })
  }

  // User is authenticated
  res.json({
    userId: authReq.authUserId,
    hasActiveSession: !!authReq.activeSession,
    profile: {
      name: "John Doe",
      email: authReq.authUserId,
    },
  })
})
```

### Bun (in `src/api/routes.ts`)

```typescript
import {requireAuth} from "./auth-helpers"

export const routes = {
  "/api/profile": requireAuth(async (req, userId) => {
    // userId is guaranteed to exist (checked by requireAuth)
    return Response.json({
      userId,
      profile: {
        name: "John Doe",
        email: userId,
      },
    })
  }),
}
```

**Alternative Bun Pattern (Manual Check):**

```typescript
import {getAuthUserId, unauthorizedResponse} from "./auth-helpers"

export const routes = {
  "/api/profile": {
    async GET(req: Request) {
      const userId = getAuthUserId(req)

      if (!userId) {
        return unauthorizedResponse("Please authenticate via /mentra-auth")
      }

      return Response.json({
        userId,
        profile: {
          name: "John Doe",
          email: userId,
        },
      })
    },
  },
}
```

---

## Optional Auth Route

Behaves differently for authenticated vs anonymous users.

### Express (in `src/index.ts`)

```typescript
expressApp.get("/api/feed", (req, res) => {
  const authReq = req as any

  if (authReq.authUserId) {
    // Authenticated user - return personalized feed
    res.json({
      message: "Your personalized feed",
      userId: authReq.authUserId,
      items: [
        {id: 1, title: "Item for " + authReq.authUserId},
        {id: 2, title: "Personalized content"},
      ],
    })
  } else {
    // Anonymous user - return public feed
    res.json({
      message: "Public feed",
      items: [
        {id: 1, title: "Public item 1"},
        {id: 2, title: "Public item 2"},
      ],
    })
  }
})
```

### Bun (in `src/api/routes.ts`)

```typescript
import {optionalAuth} from "./auth-helpers"

export const routes = {
  "/api/feed": optionalAuth(async (req, userId) => {
    if (userId) {
      // Authenticated user - return personalized feed
      return Response.json({
        message: "Your personalized feed",
        userId,
        items: [
          {id: 1, title: "Item for " + userId},
          {id: 2, title: "Personalized content"},
        ],
      })
    }

    // Anonymous user - return public feed
    return Response.json({
      message: "Public feed",
      items: [
        {id: 1, title: "Public item 1"},
        {id: 2, title: "Public item 2"},
      ],
    })
  }),
}
```

---

## Route with Path Parameters

### Express (in `src/index.ts`)

```typescript
expressApp.get("/api/users/:userId/posts/:postId", (req, res) => {
  const {userId, postId} = req.params

  res.json({
    userId,
    postId,
    post: {
      id: postId,
      author: userId,
      content: "Post content here",
    },
  })
})
```

### Bun (in `src/api/routes.ts`)

```typescript
export const routes = {
  "/api/users/:userId/posts/:postId": {
    async GET(req: Request) {
      // Extract params from URL
      const url = new URL(req.url)
      const pathParts = url.pathname.split("/").filter(Boolean)

      // Path: api/users/:userId/posts/:postId
      // Parts: [api, users, userId, posts, postId]
      const userId = pathParts[2] // index 2
      const postId = pathParts[4] // index 4

      return Response.json({
        userId,
        postId,
        post: {
          id: postId,
          author: userId,
          content: "Post content here",
        },
      })
    },
  },
}
```

**Tip:** For complex routing with params, Express is more ergonomic. For simple routes, Bun works fine.

---

## Route with POST Body

### Express (in `src/index.ts`)

```typescript
import express from "express"

// Make sure JSON body parser is enabled (AppServer does this automatically)
expressApp.post("/api/create-note", async (req, res) => {
  const authReq = req as any

  if (!authReq.authUserId) {
    return res.status(401).json({error: "Not authenticated"})
  }

  const {title, content} = req.body

  if (!title || !content) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["title", "content"],
    })
  }

  // Save note to database
  const note = {
    id: Date.now().toString(),
    userId: authReq.authUserId,
    title,
    content,
    createdAt: new Date().toISOString(),
  }

  res.status(201).json({
    success: true,
    note,
  })
})
```

### Bun (in `src/api/routes.ts`)

```typescript
import {requireAuth} from "./auth-helpers"

export const routes = {
  "/api/create-note": {
    async POST(req: Request) {
      const userId = getAuthUserId(req)

      if (!userId) {
        return unauthorizedResponse()
      }

      // Parse JSON body
      let body
      try {
        body = await req.json()
      } catch (e) {
        return Response.json({error: "Invalid JSON body"}, {status: 400})
      }

      const {title, content} = body

      if (!title || !content) {
        return Response.json(
          {
            error: "Missing required fields",
            required: ["title", "content"],
          },
          {status: 400},
        )
      }

      // Save note to database
      const note = {
        id: Date.now().toString(),
        userId,
        title,
        content,
        createdAt: new Date().toISOString(),
      }

      return Response.json(
        {
          success: true,
          note,
        },
        {status: 201},
      )
    },
  },
}
```

**Alternative with requireAuth wrapper:**

```typescript
"/api/create-note": {
  POST: requireAuth(async (req, userId) => {
    const body = await req.json()
    const { title, content } = body

    if (!title || !content) {
      return Response.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    const note = {
      id: Date.now().toString(),
      userId,
      title,
      content,
      createdAt: new Date().toISOString()
    }

    return Response.json({ success: true, note }, { status: 201 })
  })
}
```

---

## Route with Custom Headers

### Express (in `src/index.ts`)

```typescript
expressApp.get("/api/download", (req, res) => {
  const data = "file content here"

  res.setHeader("Content-Type", "text/plain")
  res.setHeader("Content-Disposition", "attachment; filename=data.txt")
  res.setHeader("X-Custom-Header", "custom-value")

  res.send(data)
})
```

### Bun (in `src/api/routes.ts`)

```typescript
export const routes = {
  "/api/download": {
    async GET(req: Request) {
      const data = "file content here"

      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Content-Disposition": "attachment; filename=data.txt",
          "X-Custom-Header": "custom-value",
        },
      })
    },
  },
}
```

---

## Comparison Summary

| Feature           | Express                            | Bun                                           |
| ----------------- | ---------------------------------- | --------------------------------------------- |
| **Auth Access**   | `req.authUserId`                   | `getAuthUserId(req)`                          |
| **Path Params**   | `req.params.id`                    | Parse from `req.url`                          |
| **Query Params**  | `req.query.search`                 | `new URL(req.url).searchParams.get('search')` |
| **POST Body**     | `req.body` (auto-parsed)           | `await req.json()`                            |
| **Response**      | `res.json({ })`                    | `Response.json({ })`                          |
| **Status Code**   | `res.status(404).json({ })`        | `Response.json({ }, { status: 404 })`         |
| **Headers**       | `res.setHeader(key, val)`          | Pass in Response options                      |
| **Hot Reload**    | ❌ No (restart needed)             | ✅ Yes (instant)                              |
| **File Location** | `src/index.ts`                     | `src/api/routes.ts`                           |
| **Best For**      | Complex routing, middleware chains | Rapid development, simple APIs                |

---

## When to Use What?

### Use Express Routes When:

- ✅ You need complex middleware chains
- ✅ You prefer traditional Express patterns
- ✅ You have existing Express experience
- ✅ You need fine-grained control over request/response
- ✅ You're building complex routing with many params

### Use Bun Routes When:

- ✅ You want hot reloading (faster development)
- ✅ You're building simple REST APIs
- ✅ You prefer modern Request/Response APIs
- ✅ You want organized route files
- ✅ You don't need complex middleware

### Hybrid Approach (Recommended):

- **Express**: MentraOS-specific routes (session management, webhooks)
- **Bun**: Your app's API routes (most of your endpoints)
- **Auth**: Works in both (forwarded via headers to Bun)

---

## Complete Working Examples

### Express Route with Everything

```typescript
// In src/index.ts, before the catch-all proxy

expressApp.post("/api/notes/:noteId/comments", async (req, res) => {
  const authReq = req as any

  // 1. Check authentication
  if (!authReq.authUserId) {
    return res.status(401).json({error: "Not authenticated"})
  }

  // 2. Get path params
  const {noteId} = req.params

  // 3. Get query params
  const {format} = req.query

  // 4. Get POST body
  const {text} = req.body

  if (!text) {
    return res.status(400).json({error: "Comment text is required"})
  }

  // 5. Create comment
  const comment = {
    id: Date.now().toString(),
    noteId,
    userId: authReq.authUserId,
    text,
    createdAt: new Date().toISOString(),
  }

  // 6. Return response with custom header
  res.setHeader("X-Comment-Id", comment.id)

  if (format === "xml") {
    res.setHeader("Content-Type", "application/xml")
    return res.send(`<comment><id>${comment.id}</id></comment>`)
  }

  res.status(201).json({
    success: true,
    comment,
  })
})
```

### Bun Route with Everything

```typescript
// In src/api/routes.ts

import {requireAuth} from "./auth-helpers"

export const routes = {
  "/api/notes/:noteId/comments": {
    POST: requireAuth(async (req, userId) => {
      // 1. Authentication already checked (userId exists)

      // 2. Get path params
      const url = new URL(req.url)
      const pathParts = url.pathname.split("/").filter(Boolean)
      const noteId = pathParts[2] // api/notes/:noteId/comments

      // 3. Get query params
      const format = url.searchParams.get("format")

      // 4. Get POST body
      const body = await req.json()
      const {text} = body

      if (!text) {
        return Response.json({error: "Comment text is required"}, {status: 400})
      }

      // 5. Create comment
      const comment = {
        id: Date.now().toString(),
        noteId,
        userId,
        text,
        createdAt: new Date().toISOString(),
      }

      // 6. Return response with custom header
      if (format === "xml") {
        return new Response(`<comment><id>${comment.id}</id></comment>`, {
          status: 201,
          headers: {
            "Content-Type": "application/xml",
            "X-Comment-Id": comment.id,
          },
        })
      }

      return Response.json(
        {
          success: true,
          comment,
        },
        {
          status: 201,
          headers: {
            "X-Comment-Id": comment.id,
          },
        },
      )
    }),
  },
}
```

---

## Testing Your Routes

### Test Express Route

```bash
# Public route
curl http://localhost:3333/api/hello

# Protected route (need to authenticate first via /mentra-auth)
curl http://localhost:3333/api/profile \
  --cookie-jar cookies.txt \
  --cookie cookies.txt

# POST request
curl -X POST http://localhost:3333/api/create-note \
  -H "Content-Type: application/json" \
  -d '{"title": "My Note", "content": "Note content"}' \
  --cookie cookies.txt
```

### Test Bun Route

Same commands! The Express proxy forwards to Bun automatically:

```bash
# These hit Bun routes (via Express proxy)
curl http://localhost:3333/api/hello
curl http://localhost:3333/api/me
curl http://localhost:3333/api/protected-example
```

---

## Next Steps

- Read [AUTH-GUIDE.md](./AUTH-GUIDE.md) for complete authentication documentation
- See [README.md](./README.md) for project setup
- Check [STRUCTURE.md](./STRUCTURE.md) for architecture details
