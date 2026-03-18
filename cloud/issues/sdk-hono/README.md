# SDK Express → Hono Refactor

Migrate `@mentra/sdk` AppServer from Express to Hono with Bun fullstack integration.

## Documents

- **[sdk-hono-spec.md](./sdk-hono-spec.md)** - Problem, goals, constraints
- **[sdk-hono-architecture.md](./sdk-hono-architecture.md)** - Technical design

## Quick Context

**Current**: AppServer extends Hono. Single server architecture (Bun.serve). Native bundling. No more Express.

**Implemented (Option C)**: AppServer provides API/webhook logic via Hono. Developer controls the `Bun.serve` instance and mounts the app. API is organized into feature-based Hono sub-apps.

## Key Insight

Bun 1.2.3+ fullstack framework provides:

- `routes`: HTML imports auto-bundled with HMR
- `fetch`: Fallback handler → delegate to Hono

```typescript
Bun.serve({
  routes: { "/*": webview }, // Bun handles React
  fetch: honoApp.fetch, // Hono handles API
  development: { hmr: true },
});
```

This eliminates the two-server pattern entirely.

## Status

- [x] Investigation of SDK Express usage (8 touch points)
- [x] Investigation of LiveCaptionsOnSmartGlasses pain points
- [x] Research Bun fullstack + Hono integration
- [x] Create implementation plan
- [x] Phase 1: Core SDK refactor (AppServer, middleware, types)
- [x] Phase 2: AppServer extends Hono
- [x] Phase 3: Bun.serve() hybrid integration (Option C)
- [x] Phase 4: Package updates
- [x] Test with LiveCaptionsOnSmartGlasses & Verify TypeScript compilation
