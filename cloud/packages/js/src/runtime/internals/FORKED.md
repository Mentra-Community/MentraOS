# Forked SDK runtime code

The TypeScript in this directory was copied from `@mentra/sdk@3.0.0-alpha.3`
on April 18 2026. Source: `MentraOS-2/cloud/packages/sdk/src/` at that
commit.

## Why this is a copy, not an import

`@mentra/js` is a proof-of-concept framework that needs to:

1. Not take a hard dependency on `@mentra/sdk`. The SDK is in alpha and
   changing rapidly. We want `@mentra/js` to boot against validated code
   without being held hostage to whatever the SDK team ships next week.
2. Fix regressions the SDK introduced but not yet validated, without
   asking the SDK team to merge our fixes on their timeline.
3. Be the home for the eventual runtime. If the POC succeeds and the
   team decides to shrink the cloud runtime in favor of `@mentra/js`,
   this code is the nucleus — not a wrapper around code we don't own.

## How this relates to the rest of `@mentra/js`

The files here are the _implementation_. Above them:

- `src/runtime/contract.ts` — public runtime contract (interfaces only).
- `src/runtime/adapters/cloud-adapter.ts` — thin binding between the
  contract and `MentraSession` in this directory. No external SDK dep.
- `src/runtime/adapters/sim-adapter.ts` — in-process simulated-glasses
  binding. Doesn't touch this directory.

## Modifications from alpha.3

**As of the initial fork (April 18 2026):** none. This is a verbatim copy.

Subsequent changes are documented inline with a `// FORK:` comment
explaining what changed and why, plus an entry in the project-root
`examples/oem-example/docs/decisions.md` when the change is
architecturally significant.

## When to re-sync

If `@mentra/sdk` ships a version that fixes something we've been living
with, we can re-sync. The process is mechanical:

1. `npm pack @mentra/sdk@<version>`
2. Diff the tarball's `dist/` against this folder.
3. Apply non-conflicting upstream changes.
4. Re-validate any `// FORK:` comments against the new upstream code.

But we're explicitly not coupled. If the SDK never ships a fix, neither
do we — we just own the code.
