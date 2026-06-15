# session/

Contains the `User` class — the per-user state container.

Each `User` composes all managers and holds the glasses `AppSession`. It's created by `SessionManager.getOrCreate(userId)` when a user connects and destroyed by `SessionManager.remove(userId)` on disconnect.

**Lifecycle:**
1. `new User(userId)` — instantiates all managers
2. `user.setAppSession(session)` — wires transcription, input, and touch listeners
3. `user.clearAppSession()` — disconnects glasses, keeps photos and SSE clients
4. `user.cleanup()` — nukes everything
