# App Store Client

## Overview

The App Store is a React SPA available at apps.mentra.glass and also embedded as a webview inside the MentraOS phone app. It serves as the public-facing marketplace where users browse, search, install, and uninstall MentraOS apps. The store has a mix of public and authenticated endpoints - browsing and searching work without auth, while user actions like installing apps require a JWT core token.

A key feature is device compatibility enrichment: when an authenticated user browses apps, the store resolves the user's wearable model and annotates each app with compatibility info specific to their hardware.

## Transport

| Transport | Endpoint(s)    | Purpose              |
| --------- | -------------- | -------------------- |
| REST      | `/api/store/*` | All store operations |

The store is REST-only. There are no WebSocket or UDP transports.

## Auth

Authentication is mixed depending on the endpoint:

| Scenario                  | Auth Mechanism                      | Details                                                      |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| Public browsing/search    | None                                | No token required for basic browse and search                |
| Authenticated browsing    | JWT core token (Bearer header)      | Enables compatibility enrichment and install status          |
| Install/uninstall actions | JWT core token (Bearer header)      | Required - rejects unauthenticated requests                  |
| Web login flow            | Supabase JWT -> core token exchange | User logs in via Supabase, exchanges for core token          |
| Webview embedding flow    | Temp token -> core token exchange   | Phone app generates a temp token, store exchanges it on load |

### Auth Flows

**Web login (apps.mentra.glass in browser):**

```
User -> Supabase login -> Supabase JWT
Store SPA -> POST /api/store/auth/exchange-token (Supabase JWT) -> core token
Store SPA uses core token for all subsequent requests
```

**Webview embedding (store inside phone app):**

```
Phone app -> POST /auth/generate-webview-token -> temp token
Phone app loads store webview with temp token in URL
Store SPA -> POST /api/store/auth/exchange-store-token (temp token) -> core token
Store SPA uses core token for all subsequent requests
```

## Operations

### Public Endpoints (No Auth)

| Method | Endpoint                    | Purpose                     | Notes                                      |
| ------ | --------------------------- | --------------------------- | ------------------------------------------ |
| GET    | `/api/store/published-apps` | Browse all published apps   | Returns basic app metadata for all users   |
| GET    | `/api/store/search?q=`      | Search apps by query string | Optional auth for compatibility enrichment |
| GET    | `/api/store/:packageName`   | App detail page             | Optional auth for compatibility enrichment |

### Authenticated Endpoints (JWT Core Token Required)

| Method | Endpoint                             | Purpose                                  | Notes                                          |
| ------ | ------------------------------------ | ---------------------------------------- | ---------------------------------------------- |
| GET    | `/api/store/published-apps-loggedin` | Apps with install status + compatibility | Enriched with user's device compatibility info |
| GET    | `/api/store/installed`               | User's installed apps                    | Returns only apps the user has installed       |
| POST   | `/api/store/install/:packageName`    | Install an app                           | Adds app to user's installed set               |
| POST   | `/api/store/uninstall/:packageName`  | Uninstall an app                         | Auto-stops the app if it is currently running  |
| GET    | `/api/store/user/me`                 | Current user info                        | Returns user profile and device info           |

### Auth Endpoints

| Method | Endpoint                               | Purpose                    | Notes                          |
| ------ | -------------------------------------- | -------------------------- | ------------------------------ |
| POST   | `/api/store/auth/exchange-token`       | Supabase JWT -> core token | Used by web login flow         |
| POST   | `/api/store/auth/exchange-store-token` | Temp token -> core token   | Used by webview embedding flow |

## Key Flows

### 1. Browse and Install (Web)

```
User visits apps.mentra.glass
  -> GET /api/store/published-apps (public, no auth)
  -> User logs in via Supabase
  -> POST /api/store/auth/exchange-token -> core token
  -> GET /api/store/published-apps-loggedin (enriched with compatibility + install status)
  -> User clicks install
  -> POST /api/store/install/:packageName
```

### 2. Browse and Install (Webview in Phone App)

```
Phone app generates temp token via /auth/generate-webview-token
Phone app opens webview to apps.mentra.glass?token=<temp>
  -> POST /api/store/auth/exchange-store-token -> core token
  -> GET /api/store/published-apps-loggedin (enriched)
  -> User clicks install
  -> POST /api/store/install/:packageName
```

### 3. Uninstall with Auto-Stop

```
User clicks uninstall on a running app
  -> POST /api/store/uninstall/:packageName
  -> Cloud checks if app is running for this user
  -> If running: cloud stops the app first (internal stop flow)
  -> App removed from user's installed set
```

### 4. Device Compatibility Enrichment

```
Authenticated request for app listing
  -> Cloud resolves user's device info (wearable model, firmware version)
  -> For each app, cloud checks hardware requirements against user's device
  -> Each app annotated with compatibility status (compatible, incompatible, unknown)
  -> Enriched list returned to client
```

## Failure Modes

### Auth Failures

| Failure                        | Current Behavior               | Target Behavior                               |
| ------------------------------ | ------------------------------ | --------------------------------------------- |
| Supabase token expired         | Exchange returns 401           | Store SPA redirects to re-login               |
| Temp token expired (webview)   | Exchange returns 401           | Webview signals phone app to regenerate token |
| Core token expired mid-session | Subsequent requests return 401 | Store SPA detects 401, triggers re-auth flow  |
| Invalid token format           | Exchange returns 400           | Clear error message displayed to user         |

### Browse/Search Failures

| Failure                        | Current Behavior                 | Target Behavior                                        |
| ------------------------------ | -------------------------------- | ------------------------------------------------------ |
| Cloud unreachable              | SPA shows loading indefinitely   | Timeout with retry button; offline message             |
| Published apps endpoint slow   | User waits with no feedback      | Loading skeleton UI; timeout after reasonable interval |
| Search returns no results      | Empty state shown                | Helpful empty state with suggestions                   |
| Compatibility enrichment fails | Falls back to unenriched listing | Show apps without compatibility badges; log error      |

### Install/Uninstall Failures

| Failure                            | Current Behavior              | Target Behavior                                          |
| ---------------------------------- | ----------------------------- | -------------------------------------------------------- |
| Install of already-installed app   | Duplicate install or error    | Idempotent - return success with current state           |
| Uninstall of not-installed app     | Error or no-op                | Idempotent - return success                              |
| Uninstall auto-stop fails          | App removed but still running | Retry stop; if stop fails, still uninstall but warn user |
| Package name not found             | 404 error                     | Clear error message: "App not found"                     |
| User not authenticated for install | 401 error                     | Redirect to login flow; retry install after auth         |

### Webview-Specific Failures

| Failure                                | Current Behavior                  | Target Behavior                                    |
| -------------------------------------- | --------------------------------- | -------------------------------------------------- |
| Phone app fails to generate temp token | Webview loads without auth        | Webview detects missing token; shows error to user |
| Webview loses connectivity             | Operations fail silently          | Detect offline state; show reconnection UI         |
| Phone app killed while webview open    | Webview orphaned with stale token | Token expiry handled gracefully; prompt re-auth    |
