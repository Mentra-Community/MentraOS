# Design Documentation Guide

How we write technical design docs for cloud features.

## Philosophy

- **Information dense, not corporate fluff**
- **Written for engineers, but readable by anyone on the team** — don't assume cloud knowledge
- **No bullshit, no filler**
- **The overview section is the most important part** — if someone skims only that, they should understand what the doc is and why it exists

## Document Flow

Every issue follows a three-stage progression:

```
spike.md → spec.md → design.md
(understand)  (decide)   (build)
```

**spike.md** — Investigation. What's the problem, what did we find, what are the options. Written after research, before committing to a solution.

**spec.md** — Specification. What are we going to do, what are the exact behaviors, what are the tradeoffs. Written after the spike, before implementation.

**design.md** — Implementation plan. Which files change, what the changes look like, rollout order, testing. Written after the spec is agreed on.

Not every issue needs all three. A small bug fix might just need a spec. A complex investigation might produce a spike that concludes "do nothing." Use judgment — but when in doubt, write more rather than less.

Each feature gets a folder: `cloud/issues/{number}-{feature-name}/`

Example: `cloud/issues/034-ws-liveness/` (matches branch `cloud/ws-liveness-detection`)

## Document Structure

Every doc starts with the same two sections:

### Overview (required, every doc)

3–5 sentences max. Answers three questions:

1. **What does this doc cover?** — one sentence
2. **Why does this doc exist?** — one sentence on the problem or context
3. **Who should read this?** — so people can self-select

This is the section people actually read. If someone reads only this and walks away with the right mental model, you've done your job.

### Background (required if non-obvious)

Just enough context that someone who doesn't work on this part of the system can follow the rest of the doc. No assumptions about what the reader knows. If a mobile engineer needs to understand a cloud concept to follow along, explain it here — briefly.

### Everything else

Depends on the doc type. See templates below.

## Templates

### spike.md

```markdown
# Spike: {Title}

## Overview

**What this doc covers:** ...
**Why this doc exists:** ...
**Who should read this:** ...

## Background

Context needed to understand the findings.

## Findings

### 1. First thing we found

### 2. Second thing we found

## Conclusions

Summary table or list: what's fixable, what's not, what we recommend.

## Next Steps

Links to spec.md / design.md if proceeding.
```

### spec.md

```markdown
# Spec: {Title}

## Overview

**What this doc covers:** ...
**Why this doc exists:** ...
**What you need to know first:** Link to spike if there is one.
**Who should read this:** ...

## The Problem in 30 Seconds

The shortest possible explanation of what's broken. Assume the reader has 30 seconds of attention.

## Spec

The actual specification — behaviors, parameters, message formats, timing.

## Decision Log

| Decision | Alternatives considered | Why we chose this |
| -------- | ----------------------- | ----------------- |

Every non-obvious decision gets a row. This prevents re-litigation in Slack.
```

### design.md

```markdown
# Design: {Title}

## Overview

**What this doc covers:** ...
**Why this doc exists:** ...
**What you need to know first:** Links to spike and spec.
**Who should read this:** ...

## Changes Summary

Table of all changes: component, file, what changes.

## {Component} Changes

### Change N: {Description}

What changes, why, code snippets showing before/after.

## Testing

How to verify it works. Edge cases to check.

## Rollout

Deployment order, backward compatibility notes.
```

## Writing Style

### Good

```markdown
## Audio Path

Client → Cloudflare → nginx Ingress → Pod :80 (HTTP/WS)
Client → LoadBalancer IP:8000 → Pod :8000 (UDP audio)

Problem: WS only carries control messages now — can go idle 60+ seconds.
nginx default proxy-read-timeout is 60s → kills the connection → 1006.
```

### Bad

```markdown
## Audio Path Architecture

### Overview

In this section, we will comprehensively explore the audio path architecture
that enables real-time communication between our client devices and the cloud
infrastructure. This is a critical component of our system...
```

## What to CUT

❌ Corporate speak ("Dear stakeholders", "executive summary", "synergy")
❌ Obvious statements ("gRPC is a remote procedure call protocol")
❌ Tutorial content ("What is REST?")
❌ Fake status tracking that won't be updated
❌ Redundant summaries across sections
❌ Motivational fluff

## What to KEEP

✅ **The overview section** — most important part of every doc
✅ **Diagrams showing actual data flow** (concise ASCII art)
✅ **Real code snippets** from the codebase with file paths
✅ **Specific numbers** (buffer sizes, timeouts, memory targets)
✅ **Decision rationale** ("Why X over Y") — prevents re-litigation
✅ **Edge cases and gotchas**
✅ **Background context** for readers outside the immediate team

## Diagrams

Use concise ASCII art:

```
Client → Go Bridge → TypeScript → Apps
         (gRPC)      (WebSocket)
```

Not:

```
╔════════════════════════════════════════════╗
║  ┌──────────┐      ┌──────────┐          ║
║  │  Client  │─────▶│   Go     │          ║
║  │          │      │  Bridge  │          ║
║  └──────────┘      └──────────┘          ║
╚════════════════════════════════════════════╝
```

## Code Examples

Always include:

- File path: `packages/cloud/src/services/AudioManager.ts`
- Line numbers if referencing existing code
- Context: "This causes X" or "This fixes Y"

## Numbers

Always specific:

- "Memory grows 500MB/hour" not "Memory grows a lot"
- "100ms chunks (1600 bytes)" not "Small chunks"
- "60s default timeout" not "a timeout"

## File Naming

- Lowercase with hyphens: `spike.md`, `spec.md`, `design.md`
- Feature folder matches issue number: `034-ws-liveness/`
- Additional files if needed: `{topic}.md` (e.g. `migration-plan.md`)

## Document Length

- spike.md: 2–5 pages
- spec.md: 3–5 pages
- design.md: 5–15 pages is fine if information-dense

**Dense and useful > short and useless**

But also: **Dense and useful > long and fluffy**

## When to Write Docs

Before implementation:

1. Investigate (spike)
2. Specify (spec)
3. Design (design)
4. Review together
5. **Then** start coding

Docs are **planning artifacts**, not post-implementation documentation.

## Examples

- `cloud/issues/034-ws-liveness/` — spike → spec → design for WebSocket liveness detection

## Anti-Patterns

❌ **Skipping the overview** — if readers don't know why the doc exists, they won't read it
❌ **Assuming cloud knowledge** — mobile engineers read these docs too
❌ **"Living document"** — docs that get stale immediately
❌ **Confluence/Notion/Google Docs** — keep it in git with code
❌ **No decision log** — leads to the same debates in Slack every week

---

**Remember**: These docs are for the whole team. Write what you'd want to read when joining the project, debugging at 2am, or trying to understand why something was built a certain way.
