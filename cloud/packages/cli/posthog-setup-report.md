<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the Mentra CLI (`@mentra/cli`). A new singleton module `src/posthog.ts` was created to initialize the `posthog-node` SDK with CLI-appropriate settings (`flushAt: 1`, `flushInterval: 0`) so events are sent immediately before the short-lived process exits. User identity is captured at login via `posthog.identify()` using the authenticated user's email as the `distinctId`, enabling correlation across all subsequent events. Exception capture (`captureException`) was added to every command's error handler. The `posthog-node` dependency was declared in `package.json` and PostHog credentials are read from environment variables.

| Event                     | Description                                             | File                    |
| ------------------------- | ------------------------------------------------------- | ----------------------- |
| `cli_authenticated`       | User successfully authenticated the CLI with an API key | `src/commands/auth.ts`  |
| `cli_logged_out`          | User cleared stored CLI credentials                     | `src/commands/auth.ts`  |
| `app_created`             | User created a new Mentra app                           | `src/commands/app.ts`   |
| `app_updated`             | User updated an existing Mentra app                     | `src/commands/app.ts`   |
| `app_deleted`             | User deleted a Mentra app                               | `src/commands/app.ts`   |
| `app_published`           | User published a Mentra app to the store                | `src/commands/app.ts`   |
| `app_api_key_regenerated` | User regenerated the API key for an app                 | `src/commands/app.ts`   |
| `app_exported`            | User exported app configuration to JSON                 | `src/commands/app.ts`   |
| `app_imported`            | User imported app configuration from JSON               | `src/commands/app.ts`   |
| `org_switched`            | User switched their default organization                | `src/commands/org.ts`   |
| `cloud_switched`          | User switched to a different Mentra cloud               | `src/commands/cloud.ts` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard — Analytics basics**: https://us.posthog.com/project/382852/dashboard/1469731
- **CLI Authentication Trend** (daily logins): https://us.posthog.com/project/382852/insights/yADvrlka
- **App Creation Funnel** (auth → create → publish): https://us.posthog.com/project/382852/insights/MpvrTYET
- **App Lifecycle Actions** (create/update/delete/publish over time): https://us.posthog.com/project/382852/insights/N375YNBL
- **Churn Signal: App Deletions** (deletions & API key regens): https://us.posthog.com/project/382852/insights/v17cYmVK
- **Active CLI Users (DAU)** (daily active users): https://us.posthog.com/project/382852/insights/XSzfq79b

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
