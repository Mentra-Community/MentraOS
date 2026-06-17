# Bugbot rules for MentraOS

When reviewing pull requests (including when triggered via `bugbot run` from the PR agent orchestrator):

## Standards

- Follow root `AGENTS.md` and path-specific `AGENTS.md` (`mobile/`, `cloud/`, etc.).
- Java/Android: Java 17, `mCamelCase` members, PascalCase classes, EventBus for component communication.
- TypeScript/React Native: functional components, single quotes, strict typing, feature-based `src/` layout.
- Swift: use swiftformat conventions.
- Do not suggest adding `Co-Authored-By:` trailers or "Generated with" lines for AI tools in commits or PR descriptions.

## Security

- Cloud/Docker MongoDB must bind to `127.0.0.1:27017`, never `0.0.0.0` or bare `27017:27017`.
- Do not commit secrets, `.env` values, or device-specific tokens.

## Orchestrator integration

When the PR agent orchestrator triggers this review, end with a top-level PR comment containing:

1. Human-readable summary
2. HTML marker `<!-- pr-agent-bugbot-verdict -->`
3. JSON footer (same schema as the other reviewers):

```json
{"verdict":"approve|changes_requested","findings":[{"severity":"blocking|nit","file":"path","line":0,"message":"..."}]}
```

- Use `blocking` only for issues that must be fixed before merge.
- Use `nit` for style or optional suggestions.
- Do not re-raise issues already listed in open `<!-- pr-agent-orchestrator -->` findings unless they regressed.

## Scope

- If changed files are outside your area of concern and look correct, approve.
- Prefer actionable, minimal findings over exhaustive nitpicks.
