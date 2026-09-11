# Bugbot rules for MentraOS

When reviewing pull requests (including when triggered via `bugbot run` from the PR agent orchestrator):

## Standards

- Follow root `AGENTS.md` and path-specific guidance such as `mobile/AGENTS.md`.
- Java/Android: Java 17, `mCamelCase` members, PascalCase classes, EventBus for component communication.
- TypeScript/React Native: functional components, single quotes, strict typing, feature-based `src/` layout.
- Swift: use swiftformat conventions.
- Do not suggest adding `Co-Authored-By:` trailers or "Generated with" lines for AI tools in commits or PR descriptions.

## Security

- Cloud/Docker MongoDB must bind to `127.0.0.1:27017`, never `0.0.0.0` or bare `27017:27017`.
- Do not commit secrets, `.env` values, or device-specific tokens.

## Orchestrator integration

The orchestrator ingests this review from the native GitHub review + inline
comments (`cursor[bot]`). High, Critical, and Medium Severity comments become
blocking findings; Low Severity stays a nit. Do not rely on a custom issue
comment — native Bugbot output is the required channel.

Optional enrichment (ignored if omitted): a top-level PR comment containing
`<!-- pr-agent-bugbot-verdict -->` plus a JSON footer in the same schema as
the other reviewers. Use it only when you can post it; never skip the native
review to write this instead.

```json
{"verdict":"approve|changes_requested","findings":[{"severity":"blocking|nit","file":"path","line":0,"message":"...","ref":"abc123"}]}
```

- Use `blocking` only for issues that must be fixed before merge.
- Use `nit` for style or optional suggestions.
- `line` is required whenever the issue is anchored to code (line at current HEAD).
- `ref` is only for re-confirming an existing entry from the orchestrator's
  open findings: copy that entry's exact `id`. Omit `ref` for anything new.
  Never invent ids.
- The orchestrator's `<!-- pr-agent-orchestrator -->` state comment lists prior
  open findings. Treat each as a hypothesis, not a fact: check the current
  code at HEAD before repeating one. If it's already fixed, leave it out of
  your findings — the orchestrator resolves it automatically once you stop
  reporting it. Only repeat it if you can point to code that still exhibits it.
- Do not re-raise issues already listed as *resolved* unless they regressed.

## Scope

- If changed files are outside your area of concern and look correct, approve.
- Prefer actionable, minimal findings over exhaustive nitpicks.
