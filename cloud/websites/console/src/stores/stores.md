# Console Zustand Stores Plan

This document outlines three lightweight Zustand stores for the Developer Console:

- account.store (auth/session user)
- org.store (organizations and selection)
- app.store (applications under current org)

The goal is to make org context explicit and reliable in the Console, while keeping the UI decoupled from legacy backend behaviors and ready for migration to /api/console.

---

Principles

- Keep stores minimal and predictable.
- Default org creation happens in Cloud (not in the Console UI).
- Cloud should ensure a user has at least one org at auth and/or on org-required actions.
- While legacy routes exist, set a global header for org context:
  - axios.defaults.headers["x-org-id"] = selectedOrgId (when it changes)
- Persist the selected org locally using key: console:selectedOrgId
- Assume new /api/console routes for planning; legacy routes are a temporary bridge.

---

Shared initialization flow

1. accountStore: set token (Authorization: Bearer <coreToken>) and fetch user profile.
2. orgStore: load orgs; restore selectedOrgId from localStorage if present and valid; otherwise select the first.
3. appStore: fetch apps for the selectedOrgId.

This keeps the UI stable even when legacy routes are still active.

---

Store: account.store

Responsibilities

- Hold session user and auth state.
- Provide token setup hook for the API client.
- Expose basic signed-in user details for UI components.

State (example)

- email: string | null
- signedIn: boolean
- loading: boolean
- error: string | null

Actions (example)

- setToken(token: string): sets Authorization header for the API client
- fetchMe(): GET /api/console/auth/me (target) or GET /api/dev/auth/me (legacy)
  - Returns user info, including organizations and defaultOrg from Cloud
- signOut(): clears session state; consumer clears token

Notes

- Do not create orgs in the account store. Cloud is responsible.
- If fetchMe indicates zero orgs (edge case), orgStore will handle UI prompts/retry and not auto-create in the UI by policy.

---

Store: org.store

Responsibilities

- Manage the list of orgs and the selected org.
- Keep axios.defaults.headers["x-org-id"] in sync with the selection.
- Persist selectedOrgId locally so a refresh honors the previous choice.

State (example)

- orgs: Organization[]
- selectedOrgId: string | null
- loading: boolean
- error: string | null

Derived

- selectedOrg: Organization | undefined

Actions (example)

- bootstrap():
  - loadOrgs()
  - restore selectedOrgId from localStorage ("console:selectedOrgId")
  - if invalid/missing, select the first org
- loadOrgs():
  - GET /api/console/orgs (target) or GET /api/orgs (legacy)
- setSelectedOrgId(orgId: string):
  - set state
  - set axios.defaults.headers["x-org-id"] = orgId (bridge for legacy /api/dev/\*)
  - persist to localStorage ("console:selectedOrgId")
- createOrg(name: string):
  - POST /api/console/orgs (target) or POST /api/orgs (legacy)
  - append to orgs; select it; persist and update header

Notes

- Expect Cloud to ensure an org exists. If no orgs are returned (edge):
  - Show a prompt and a retry option (do not auto-create in the UI by policy).
- As we migrate to /api/console, org context can be moved to the path for new routes, but the store still maintains selectedOrgId for UI.

---

Store: app.store

Responsibilities

- Manage list and details of apps for the selected org.
- Provide CRUD and operational actions (publish, regenerate API key, move org).

State (example)

- appsByPackage: Record<string, AppResponse>
- list: string[] (ordered packageNames for current view)
- loading: boolean
- error: string | null
- lastFetchedAt: number | null

Actions (example)

- fetchApps():
  - Legacy: GET /api/dev/apps (x-org-id header set globally)
  - Target: GET /api/console/apps?orgId=<selectedOrgId>
  - Store results into appsByPackage and list
- getApp(packageName: string):
  - Legacy: GET /api/dev/apps/:packageName
  - Target: GET /api/console/app/:packageName
- createApp(appData):
  - Legacy: POST /api/dev/apps/register (x-org-id)
  - Target: POST /api/console/apps (body may include orgId)
- updateApp(packageName, data):
  - Legacy: PUT /api/dev/apps/:packageName
  - Target: PUT /api/console/app/:packageName
- deleteApp(packageName):
  - Legacy: DELETE /api/dev/apps/:packageName
  - Target: DELETE /api/console/app/:packageName
- publishApp(packageName):
  - Legacy: POST /api/dev/apps/:packageName/publish
  - Target: POST /api/console/app/:packageName/publish
- regenerateApiKey(packageName):
  - Legacy: POST /api/dev/apps/:packageName/api-key
  - Target: POST /api/console/app/:packageName/api-key
- moveApp(packageName, targetOrgId):
  - Legacy: POST /api/dev/apps/:packageName/move-org
  - Target: POST /api/console/app/:packageName/move (body: { targetOrgId })

Notes

- On org change (org.store.setSelectedOrgId), consider clearing the list and refetching apps, or lazily refetch on route/view entry.
- For optimistic updates, only apply when server responses are reliable and UI guarantees can be backed out.

---

Initialization (application shell)

- After token is set by the auth flow:
  - await accountStore.fetchMe()
  - await orgStore.bootstrap()
  - if (orgStore.selectedOrgId) await appStore.fetchApps()

This provides a consistent experience whether on legacy or target routes.

---

Error handling and UX

- accountStore.fetchMe errors: show a session error and prompt re-auth.
- orgStore.loadOrgs errors: retries/backoff; if empty list (edge), prompt the user and provide a retry. Do not auto-create in the UI.
- appStore.fetchApps errors: show toast/banner with a retry button.

---

Persistence

- Key: "console:selectedOrgId"
- Behavior:
  - Write on org selection change
  - Read during org.store.bootstrap
  - Validate against current orgs; if invalid, fall back to the first org

---

Endpoint references

Current (legacy bridge)

- Orgs:
  - GET /api/orgs
  - POST /api/orgs
- Apps:
  - GET /api/dev/apps
  - GET /api/dev/apps/:packageName
  - POST /api/dev/apps/register
  - PUT /api/dev/apps/:packageName
  - DELETE /api/dev/apps/:packageName
  - POST /api/dev/apps/:packageName/api-key
  - POST /api/dev/apps/:packageName/publish
  - POST /api/dev/apps/:packageName/move-org

Target (/api/console)

- Orgs: /api/console/orgs (GET/POST/GET:orgId/PUT:orgId/DELETE:orgId/…)
- Apps (flat namespace, orgId provided via query or body when needed):
  - GET /api/console/apps?orgId=<id>
  - POST /api/console/apps
  - GET /api/console/app/:packageName
  - PUT /api/console/app/:packageName
  - DELETE /api/console/app/:packageName
  - POST /api/console/app/:packageName/api-key
  - POST /api/console/app/:packageName/publish
  - POST /api/console/app/:packageName/move

---

Testing checklist

- With an existing org
  - accountStore.fetchMe succeeds; orgStore.bootstrap selects persisted or first org
  - appStore.fetchApps loads apps for selected org
- With no org (edge)
  - accountStore.fetchMe succeeds; orgStore.loadOrgs returns empty
  - UI shows prompt and retry (no auto-create in the UI by policy)
- Org switching
  - selected org changes updates axios.defaults.headers["x-org-id"]
  - appStore is able to fetch apps for the new org
- CRUD actions
  - create/update/delete/publish/regenerate/move behave as expected; errors are surfaced

---

Example interfaces (for reference)

type Organization = {
id: string
name: string
slug?: string
profile?: { contactEmail?: string; website?: string; description?: string; logo?: string }
createdAt?: string
updatedAt?: string
}

type AppResponse = {
packageName: string
name: string
description?: string
publicUrl?: string
appStoreStatus?: "DEVELOPMENT" | "SUBMITTED" | "REJECTED" | "PUBLISHED"
createdAt?: string
updatedAt?: string
// ...and any additional fields used by the UI
}

---

Notes

- The stores are intentionally minimal. Additional stores (permissions, assets) can be added later if needed.
- As we migrate to /api/console, only endpoints change; store responsibilities and flow remain the same.
