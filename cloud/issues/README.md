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

### Process Rules

**The stages are sequential. Do not skip ahead.**

1. **Investigate and discuss before writing anything.** The investigation happens in conversation — reading code, querying logs, tracing flows, forming hypotheses, testing them. All findings should be discussed, iterated on, and agreed upon in chat before any doc is written. The spike is the *consolidation* of that shared understanding, not the place where understanding is developed.

2. **Don't write a spike until the investigation is complete and aligned.** A spike captures confirmed findings that both parties understand and agree on. If you're still speculating ("possibly," "likely," "needs investigation"), you're not ready to write — keep investigating in chat. The spike should feel like writing down what you already know, not figuring it out as you go.

3. **Don't write a spec until the spike is written and reviewed.** The spec defines *what* we're going to do. It should reference the spike's findings. If the findings change, the spec is wasted work.

4. **Don't write a design doc until the spec is agreed on.** The design doc defines *how* we're going to implement the spec. If the *what* changes, the *how* is wasted work.

5. **AI agents: investigate in chat, write docs only when asked.** When asked to investigate an issue, do the research — read code, query logs, trace flows, explain findings in conversation. Do NOT immediately produce a spike document. Wait until the investigation is discussed, aligned, and the human says to write it up. Same for specs and design docs — discuss first, write when asked. Never bundle spike + spec + design in one pass.

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

## Decision Log

| Decision | Alternatives considered | Why we chose this |
| -------- | ----------------------- | ----------------- |

Every non-obvious implementation decision gets a row. Include things that
didn't work (build failures, runtime issues, API mismatches) and why the
approach was changed. If the design evolved during implementation, document
what changed and why — don't silently overwrite the original decision.

The goal: someone reading this months later should understand not just what
was built, but what was tried, what failed, and why the final approach won.

## Testing

How to verify it works. Edge cases to check.

## Rollout

Deployment order, backward compatibility notes.
```

**Keeping the design doc current:** The design doc is the source of truth for what was actually built. If implementation reveals that the original design doesn't work (a method doesn't exist on a type, a library doesn't support an API, a runtime behavior differs from what we expected), update the design doc:

1. **Update the "after" code** to reflect what was actually shipped
2. **Add the failed approach to the Decision Log** with why it didn't work
3. **Don't delete the original thinking** — move it to "Alternatives considered" so future readers understand the journey

The design doc is not a spec (what we plan to do) — it's a record of what we did and why. It should match the code at all times.

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

1. Investigate in conversation — read code, query logs, trace flows, discuss findings
2. **Align on understanding** — both parties agree on root cause and findings
3. Write spike — consolidate the agreed findings into a document
4. **Review spike** — confirm it captures the investigation accurately
5. Discuss solution approach — explore options in conversation
6. Write spec — consolidate the agreed approach into a document
7. **Review spec** — confirm the approach before designing
8. Write design doc — plan the implementation
9. **Review design** — confirm before coding
10. **Then** start coding

The key: investigation and discussion happen in conversation. Documents are the *output* of that discussion, not the medium for it. Don't write to think — think first, then write to record.

Docs are **planning artifacts**, not post-implementation documentation.

## Examples

- `cloud/issues/034-ws-liveness/` — spike → spec → design for WebSocket liveness detection

## Security & Privacy

**This is a public, open-source repository.** Every file committed here is visible to the world. Write docs accordingly.

### Never commit

❌ **Tokens, secrets, API keys, passwords, or credentials** — not even in examples. Use placeholders like `$BETTERSTACK_SOURCE_TOKEN` or `(stored in cloud/.env)` instead. If you need to reference a specific token for context, describe where it lives, never paste the value.

❌ **Personally identifiable information (PII)** — no customer emails, real user IDs, names, phone numbers, or IP addresses in docs. Use anonymized examples: `user@example.com`, `session-abc123`, `10.x.x.x`.

❌ **Internal URLs with embedded credentials** — no database connection strings, no webhook URLs with tokens in the query string.

❌ **Private conversations** — if a team member said something in Slack, a call, or a meeting that provides useful context, paraphrase the technical insight. Don't attribute it or quote it. The docs are for the public repo, not a meeting transcript.

### Always use

✅ **Placeholders for secrets:** `$ENV_VAR_NAME`, `(see cloud/.env)`, `(stored in Porter/Doppler)`

✅ **Anonymized data:** `user@example.com`, `session-12345`, `<redacted>`

✅ **References to where secrets live:** "The BetterStack source token is configured via the `BETTERSTACK_SOURCE_TOKEN` environment variable in Porter."

### Before committing any doc

Ask yourself: **if a stranger reads this file on GitHub, is there anything they could use to access our systems, identify our users, or impersonate a team member?** If yes, redact it.

### For AI agents writing docs

If you are an AI agent (Claude, Codex, Copilot, etc.) generating or editing these docs:

- **Never include real tokens, keys, or credentials** that were shared with you in conversation. The conversation is private; the repo is public.
- **Never include real customer emails or user IDs** from logs, BetterStack queries, or database output. Anonymize them.
- **Never attribute statements to specific team members** unless they've explicitly approved it. Paraphrase the technical content.
- **Always use `$VARIABLE_NAME` or `(stored in <location>)`** when referencing secrets, even if you have the actual value.
- **Always build locally before pushing** — run the same build command CI uses (`bun run build` in the package directory). Don't push code that hasn't been verified to compile.
- **Always confirm before making infrastructure changes** — creating BetterStack sources, installing Helm charts, modifying uptime monitors, etc. Ask first, act second.

---

## Anti-Patterns

❌ **Skipping the overview** — if readers don't know why the doc exists, they won't read it
❌ **Assuming cloud knowledge** — mobile engineers read these docs too
❌ **"Living document"** — docs that get stale immediately
❌ **Confluence/Notion/Google Docs** — keep it in git with code
❌ **No decision log** — leads to the same debates in Slack every week
❌ **Committing secrets in docs** — tokens, API keys, passwords, connection strings. Use placeholders.
❌ **Including real PII** — customer emails, user IDs from production logs. Anonymize.
❌ **Skipping the design doc** — don't go straight from spec to implementation. The design doc is where implementation details get reviewed before code is written.
❌ **Writing docs while still investigating** — investigate in conversation first. Documents consolidate agreed findings, they don't develop them.
❌ **Writing specs before the spike is reviewed** — if the findings change, the spec is wasted work.
❌ **Writing design docs before the spec is agreed** — if the approach changes, the design is wasted work.
❌ **Bundling spike + spec + design in one pass** — each stage needs discussion and agreement before the next. Rushing through all three produces docs built on unverified assumptions.
❌ **AI agents writing docs preemptively** — investigate and explain in chat. Only write the document when the human says the understanding is aligned and asks for it.

---

**Remember**: These docs are for the whole team **and the public**. Write what you'd want to read when joining the project, debugging at 2am, or trying to understand why something was built a certain way — but never include anything that could compromise security or privacy if read by a stranger.
