# Bug Spec: WebSocket Course Correction Detection

## Problem

For some users, the WebSocket between the mobile client and the cloud breaks, and the client fails to reconnect in a reasonable amount of time. The client code relies on `onClose` or `onError` events when the WebSocket breaks, but it can take up to a minute for the OS to detect a broken WebSocket. This causes the `UserSession` in the cloud to be disposed, leading to:

- No display requests or audio events from the cloud
- 503 errors when users try to start apps

## What This Looks Like in Production

The user taps a mini app. Gets _"app is currently not available, please contact the developer."_

The app is fine — the WebSocket is dead and the client doesn't know it.

**Current workaround:** Go to developer settings, re-save the same server URL. This forces a full reconnect.

## Why

The client can sit on a dead WebSocket without knowing it. When the user taps a mini app:

1. The mobile sends `POST /apps/:packageName/start` over REST
2. The cloud looks up the user's session via `UserSession.getById(email)` — but the session is dead (or disposed)
3. The cloud returns **503** `no_active_session`: _"No active cloud session. Please ensure your app is connected."_ — [client.middleware.ts:163-171](cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts#L163-L171)
4. The mobile shows _"app not available, contact the developer"_

**The error message is wrong. The app is fine. The session is dead.**

## Desired Behaviour

- The client should be able to detect when WebSockets are broken **within 5 seconds** of the WebSocket breaking (some clients already detect and reconnect).
- When the WebSocket breaks, the client should reconnect.
- If the client fails to reconnect to the cloud, we should think about how we can improve observability into this failure mode so we can understand why.
- Have appropriate error codes / logs / alerts to understand the different failure modes.
- The cloud should give an identifiable error code on any failed REST request to indicate there is no `UserSession`, so the client knows to reconnect.
