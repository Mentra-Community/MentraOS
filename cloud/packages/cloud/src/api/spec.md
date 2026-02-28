# Api Spec

Author: Isaiah

## Overview

Most of the current api routes and handlers are current defined under `./src/routes`
As the project has grown it has become very unorganized and most files invent their own middleware
or have unclear confusing and conflicting names for their routes and handlers.
Most endpoints are used by different services and small changes cause frequent bugs from building on top of old logic that has changed drasticly
In an effort to fix these issues and better organize the routes, the goal is to slowly refactor and migrate the improved routes and endpoints under this api folder in a more oganized way.

## Problem

- Routes under `src/routes`/`src/router` are inconsistent (naming, middleware, ownership).
- Multiple services depend on the same endpoints; changes cause regressions.
- Route wiring mixed in `src/index.ts` makes ownership and discovery unclear.
- Handlers contain business logic, making them hard to read and reuse.

## Goals

- Organize APIs by audience: `client/`, `store/`, `sdk/`, `console/`, `admin/` under `src/api/`.
- Mirror the same structure under `src/services/` for business logic.
- One resource per file; small, readable handlers that delegate to services.
- Centralize mounting in `src/api/index.ts`; move wiring out of `src/index.ts`.
- Migrate gradually; keep legacy thin until removed.

## Non-Goals

- Rewriting services/models now.
- Changing response envelope or auth semantics.
- Introducing new validation frameworks.
- Big-bang refactor; migration is incremental.

## Scope

- Applies only to API route files in this folder.
- Business logic lives in `src/services` (mirrors the same folder layout).

## Directory layout

- `src/api/`
  - `client/` public/mobile/web client APIs
  - `console/` developer console APIs
  - `store/` app store / catalog APIs
  - `sdk/` sdk (app-runtime)
  - `admin/` privileged/internal APIs

Services mirror this structure in `src/services/` (client/console/store/sdk/admin).

## File conventions

- One resource per file, e.g. `user-settings.api.ts`.
- Default export a single `router`.
- Short header comment listing base path and endpoints.
- Routes declared at the top; handler implementations below as function declarations (hoisted).
- Use per-route middleware (e.g., `authWithUser`) rather than global.

## Mounting and migration

- A central `src/api/index.ts` mounts sub-routers:
  - `/api/client/*`, `/api/console/*`, `/api/store/*`, `/api/sdk/*`, `/api/admin/*`
- Move route wiring out of `src/index.ts` into `src/api/index.ts`.
- Legacy routes currently under `src/routes` and `src/router` remain for now.
  - Add a brief comment in `src/api/index.ts` explaining the deprecation plan.
  - As files are touched, migrate them into `src/api/*` and point callers to the new paths.
  - Keep the legacy layer thin; avoid adding new features there.

## Routing style

- Keep paths explicit and unambiguous (e.g., prefer `/key/:key` over `/:key` when it reads better).
- Keep handler bodies small—validate minimal inputs, call service, respond.
- Avoid business logic in handlers; delegate to `src/services/<domain>/*`.

## Implementation

1. Create `src/api/index.ts` and mount sub-routers at `/api/client|store|app|admin|console|account`.
2. For each resource:
   - Add `*.api.ts` under the correct audience folder.
   - Export a single `router`; declare routes at top, handlers below.
   - Delegate to matching `src/services/<audience>/*` service.
3. Migrate routes from `src/routes`/`src/router` as touched; add a brief deprecation comment.
4. Keep legacy routes wired for now; no new features added there.

## Adding a new API

- Choose the audience folder (`client/`, `store/`, `sdk/`, `admin/`, `console/`).
- Create a `*.api.ts` file (one resource per file).
- Export a `router` and register routes at the top.
- Mount it from `src/api/index.ts` under the correct base path.
