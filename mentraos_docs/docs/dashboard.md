---
title: Dashboard
---

# Dashboard Tutorial

## What is the Dashboard?

The **dashboard** is a persistent UI surface that MentraOS renders on the smart-glasses when the user looks up.  It can show system information (time, battery, status) and content contributed by apps.  Your app can treat the dashboard as an additional, lightweight display surface that remains visible even when other apps are in the foreground.

MentraOS exposes a high-level *Dashboard API* through `TpaSession`.  You do **not** need to manage WebSocket messages or layouts manually—the SDK takes care of that.  All you have to do is call a few convenience methods on `session.dashboard.content`.

## Dashboard Modes

| Mode | Purpose | Typical Size |
| :--- | :------ | :----------- |
| `main` | Full dashboard experience | Medium |
| `expanded` | Gives more space to your app's content when the user explicitly expands the dashboard | Large |
| `always-on` <sup>coming soon</sup>| Minimal overlay that sits on top of other content | Very small |

When you write to the dashboard you can choose which mode(s) the content targets.

## Prerequisites

1. MentraOS SDK ≥ `0.13.0` installed in your project.
2. A working app server with a standard `onSession` implementation (see the [Quickstart](/quickstart) guide).

## Hello-Dashboard in 3 Steps

```typescript title="packages/apps/hello-dashboard/src/index.ts"
import { TpaServer, TpaSession, DashboardMode } from '@mentra/sdk';

class HelloDashboardServer extends TpaServer {
  protected async onSession(session: TpaSession, sessionId: string, userId: string) {
    // 1️⃣  Write a welcome message to the *main* dashboard
    session.dashboard.content.writeToMain('👋 Hello from my app!');

    // 2️⃣  Listen for mode changes (optional)
    const unsubscribe = session.dashboard.content.onModeChange((mode) => {
      session.logger.info(`Dashboard mode is now: ${mode}`);
    });

    // 3️⃣  Clean up when the session ends
    this.addCleanupHandler(unsubscribe);
  }
}
```

That's **all** you need—no subscriptions, no manual layout construction.  The SDK handles the heavy lifting.

## Targeting Multiple Modes

Use `write(content, targets)` when you want to send the same content to several modes at once:

```typescript
session.dashboard.content.write(
  '📢  New version available',
  [DashboardMode.MAIN, DashboardMode.EXPANDED]
);
```

## Adapting Content for Expanded Mode

The *expanded* mode gives your app more room to breathe.  A common pattern is to show a concise headline in *main* mode and a longer explanation in *expanded* mode:

```typescript
// Concise headline
session.dashboard.content.writeToMain('💡 Did you know…');

// Detailed explanation
session.dashboard.content.writeToExpanded(
  'The Eiffel Tower can be 15 cm taller during hot days due to thermal expansion.'
);
```

## Listening for Mode Changes

Your app can adapt to user actions by reacting to dashboard mode transitions:

```typescript
const unsubscribe = session.dashboard.content.onModeChange((mode) => {
  if (mode === DashboardMode.MAIN) {
    console.log('Dashboard collapsed – switch to compact content');
  }
});
```

Call the returned `unsubscribe()` function when you no longer need the handler.

## Best Practices

1. **Be concise** – Users glance at the dashboard; keep messages short.
3. **Use mode-appropriate length** – Short for *main*, longer for *expanded*.
5. **Respect user settings** – Provide toggles or frequency controls so users can decide how often content appears.

## Next Steps

* Read the [Dashboard API reference](/reference/dashboard-api) for detailed method signatures, types, and enums.
* Join our Discord community if you have questions or feedback.
