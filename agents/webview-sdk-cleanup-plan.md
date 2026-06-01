# Old Webview-SDK Cleanup Plan

Branch: `mentra-miniapp-sdk`

## Context

This branch contains two coexisting "local webview-based miniapp" systems:

1. **NEW (keep):** `@mentra/miniapp` at `sdk/miniapp/` — the real miniapp SDK being actively built. Phone-side runtime lives in `mobile/src/services/LocalMiniappRuntime.ts`, `mobile/src/services/MicStateCoordinator.ts`, and `mobile/src/components/miniapp/MiniappHost.tsx`.
2. **OLD (delete):** `@mentra/webview-sdk` at `mobile/webview/` — another engineer's experiment. Never shipped, never imported by any active code.

Sanity checks already performed from repo root:

```bash
grep -rn "@mentra/webview-sdk" . --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.md" | grep -v node_modules | grep -v "mobile/webview/"
# → zero hits

grep -rn "mobile/webview" . --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.sh" | grep -v node_modules | grep -v "^\./mobile/webview/"
# → zero hits

grep -rnE "requestTranscriptions|stopTranscriptions|requestMovement|stopMovement" . | grep -v node_modules | grep -v "^\./mobile/webview/"
# → zero hits (old API names are confined to the old tree)
```

Conclusion: the old tree is fully isolated. Deletion is safe and does not require any refactor first.

---

## Items to clean up

### 1. Delete the entire `mobile/webview/` directory

Everything under this path is dead weight. ~392 KB, 33 files.

- [ ] `mobile/webview/package.json`
- [ ] `mobile/webview/bun.lock`
- [ ] `mobile/webview/sdk/` (whole subtree — `@mentra/webview-sdk` package)
  - `package.json`, `bun.lock`, `tsconfig.json`, `README.md`, `.gitignore`
  - `src/index.ts`, `core.ts`, `events.ts`, `bridge.ts`, `socket-bridge.ts`, `types.ts`
- [ ] `mobile/webview/examples/react-app/` (whole subtree — old Vite example app)
  - `package.json`, `bun.lock`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`
  - `tailwind.config.js`, `postcss.config.js`, `README.md`, `.gitignore`, `index.html`
  - `src/App.tsx`, `src/main.tsx`, `src/index.css`
  - `assets/icon.png`, `assets/app.json`
  - `dist/index.html`, `dist/app.json`, `dist/icon.png` ← **stale build artifact committed to git**

Command:

```bash
git rm -r mobile/webview/
```

### 2. Update the historical planning doc

`agents/local-app-runtime-plan.md` references an old `mobile/src/components/home/LocalMiniApp.tsx` component that was never actually created — the real implementation went through `MiniappHost.tsx` instead. References appear at lines 899, 904, 909, 952, 1000, 1004, 1010, 1030, 1031, 1108, 1825, 1987.

Options:

- [ ] **(Preferred)** Add a short preamble at the top of the doc: "Historical planning document. The `LocalMiniApp.tsx` component referenced below was never built — the final implementation lives in `mobile/src/components/miniapp/MiniappHost.tsx` and `mobile/src/app/applet/local.tsx`."
- [ ] Or: leave untouched (it's clearly a dated plan doc; low confusion risk once the old tree is gone).

No code changes required either way.

---

## Files that look related but are NOT old — do not touch

These all belong to the new system. Listed here so nobody mistakes them for old code during cleanup review:

| File | Why it looks suspicious | What it actually is |
|---|---|---|
| `mobile/src/app/applet/local.tsx` | Exports `LocalMiniAppPage` | New system route; mounts miniapps via `miniappHost.mount()` / `mountDev()`. |
| `mobile/src/stores/applets.ts` | Exports `useLocalMiniApps` hook | New system — list of installed local miniapps. |
| `mobile/src/services/Composer.ts` (`getLocalMiniAppHtml`) | Method name contains "LocalMiniApp" | New system — resolves bundle HTML for `MiniappHost`. |
| `mobile/src/effects/Compositor.tsx`, `mobile/src/effects/TranscriptionsListener.tsx` | Import `useLocalMiniApps` | New system consumers. |
| `mobile/src/services/MiniComms.ts` | Name overlaps with older local-miniapp messaging | Post-refactor, only handles **cloud** miniapps. Local miniapps bypass it entirely via `LocalMiniappRuntime`. Optional future work: rename/comment to disambiguate, but out of scope for this cleanup. |

---

## Execution order

1. Run the three grep sanity checks above once more right before deleting (belt and suspenders).
2. `git rm -r mobile/webview/`
3. Optionally update `agents/local-app-runtime-plan.md` preamble.
4. Commit. Suggested message:

   ```
   Remove unused @mentra/webview-sdk experiment

   The mobile/webview/ tree was a never-shipped experiment from another
   engineer and has zero imports from any active code. It coexisted with
   the real @mentra/miniapp SDK (sdk/miniapp/) and caused confusion. The
   new system's phone-side runtime lives in LocalMiniappRuntime,
   MicStateCoordinator, and MiniappHost and is unaffected by this removal.
   ```

5. Post-delete verification:
   ```bash
   # Both should return zero hits.
   grep -rn "@mentra/webview-sdk" . --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.md" | grep -v node_modules
   grep -rn "mobile/webview" . --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.md" | grep -v node_modules
   ```
6. Rebuild mobile (`cd mobile && bun install && bun start`) to confirm Metro still resolves `@mentra/miniapp` and no workspace entry broke.

---

## Out of scope (intentionally)

- Renaming `MiniComms` to clarify it's cloud-only now.
- Renaming `useLocalMiniApps` / `getLocalMiniAppHtml` / `LocalMiniAppPage` to match the "mini app" (two-word) convention.
- Any changes inside `sdk/miniapp/` or `sdk/example-miniapp/`.

Those are separate cleanups; bundling them here would muddy the diff.
