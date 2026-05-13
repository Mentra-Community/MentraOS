# Miniapp Hardware Requirements — Implementation Plan

Branch: `mentra-miniapp-sdk`
Scope: add `hardwareRequirements` (required) to `miniapp.json` for the new local miniapp SDK, and wire it into the mobile app so the existing cloud-app compatibility UX (greyed icon + tap-to-show-missing-hardware dialog) applies to local miniapps too.

## Goals

1. **`miniapp.json`**: `hardwareRequirements` becomes a **required** field. Every new miniapp declares what hardware it needs.
2. **Mobile UX parity with cloud miniapps**: incompatible local miniapps are greyed out in the launcher; tapping shows the same "Hardware Incompatible / your glasses lack X, Y" dialog cloud apps already use.
3. **No new dialogs, no new components, no new translations.** Reuse `HardwareCompatibility.checkCompatibility`, `AppIcon`, `startApplet`'s alert flow, and the existing `home:hardwareIncompatible*` translation keys.

## Non-goals

- Install-time blocking (cloud does some pre-install checks — not relevant here, local miniapps don't have a store install flow yet).
- Auto-stop currently running miniapps if the user switches glasses mid-session. Cloud doesn't do that either; the subscription at `applets.ts:1047-1067` just updates the greyed state.
- Optional-hardware UI treatment (warnings about missing optional hw). Cloud today only surfaces `missingRequired` in the tap dialog. We match.

---

## Ground truth (already in the codebase, reused as-is)

| Piece | Location | Notes |
|---|---|---|
| Compat fn | `mobile/src/utils/hardware/hardware.ts:30-65` `HardwareCompatibility.checkCompatibility(requirements, capabilities)` | Returns `{isCompatible, missingRequired, missingOptional, warnings}` |
| Capabilities source | `getModelCapabilities(deviceType)` + `useSettingsStore(SETTINGS.default_wearable)` — used at `applets.ts:758-759` | Unchanged |
| Compat loop | `applets.ts:761-765` inside `refreshApplets()` | Already iterates every applet regardless of origin — we just need local miniapps to carry `hardwareRequirements` when they reach it |
| Recompute on wearable switch | `applets.ts:1047-1067` subscription | Works automatically once #1 is in place |
| Greyed-out icon | `mobile/src/components/home/AppIcon.tsx:40` → `opacity-50` when `!app.compatibility?.isCompatible` | Unchanged |
| Tap-to-launch block + alert | `applets.ts:789-833` `startApplet()` | Already handles `EXIST`-missing (→ `home:glassesRequired` dialog) and other-missing (→ `home:hardwareIncompatible` dialog). Works for any applet with `.compatibility` set |
| Hardware types + levels | `cloud/packages/types/src/hardware.ts` + `enums.ts` — `HardwareType` (CAMERA, DISPLAY, MICROPHONE, SPEAKER, IMU, BUTTON, LIGHT, WIFI, EXIST) + `HardwareRequirementLevel` (REQUIRED, OPTIONAL) | Import both into SDK; don't redefine |

---

## Channels local miniapps arrive through today

From `applets.ts:707-733`:

1. **Installed local miniapps** — `composer.getLocalApplets()` (line 731). Resolves from the bundle dir; whatever manifest shape this returns is what we need to make sure includes `hardwareRequirements`.
2. **Dev-loaded miniapps** (QR scan / URL) — live in `state.apps.filter((a) => a.isMiniappDev)` (line 725). These get pushed into the store by `/applet/local` route + `MiniappHost.mountDev`. Manifest fetch currently only extracts `permissions` (see `MiniappHost.tsx:149-156`).

Both paths merge into `applets` before hitting the compat loop, so both need `hardwareRequirements` populated at their respective source.

---

## Implementation

### Part 1 — Manifest schema

**`sdk/miniapp-cli/src/manifest.ts`**
- Add `hardwareRequirements` validation: **required**, non-empty array. Each entry must have `type` in the 9 allowed values and `level` in `REQUIRED | OPTIONAL`; `description` optional.
- Keep `ALLOWED_PERMISSIONS` list but also fix the pre-existing permissions validator bug: it checks `!ALLOWED_PERMISSIONS.includes(perm)` against raw entries, but the actual manifest shape is `{type, description}`. Update the loop to look at `perm.type`. (Worth fixing while we're here; otherwise the upcoming hardwareRequirements loop will stand out as inconsistent.)
- Export a plain TypeScript type (e.g. `MiniappManifestV1`) alongside `validateManifest` for consumers that want a compile-time shape. Keep it a lightweight local type — don't pull in `@mentra/types` (CLI has deliberately avoided that dep per the top-of-file comment).

**`sdk/miniapp/src/` (SDK itself)**
- Re-export `HardwareRequirement`, `HardwareType`, `HardwareRequirementLevel` from `@mentra/sdk` (or `@mentra/types`, whichever is the right public surface — check what `sdk/miniapp/package.json` already depends on). Single source of truth; no parallel definition.
- The SDK runtime doesn't use these itself (miniapps are the ones declaring them), but exporting them makes it trivial for developers to type their `miniapp.json` in TS-authored projects.

**`sdk/example-miniapp/miniapp.json`**
- Add `hardwareRequirements`. At minimum: `[{type: "DISPLAY", level: "REQUIRED"}, {type: "MICROPHONE", level: "REQUIRED"}]` (since the example does transcription + text wall).

**`sdk/create-mentra-miniapp/template/miniapp.json`**
- Add a sensible default: `[{type: "DISPLAY", level: "REQUIRED"}]`. New miniapps almost certainly need display.

### Part 2 — Phone reads `hardwareRequirements` for dev miniapps

**`mobile/src/components/miniapp/MiniappHost.tsx`** (`mountDev`, lines 140-182):
- Widen the manifest fetch to also pull `hardwareRequirements`.
- Pass it through to `localMiniappRuntime.setInstalledManifest(packageName, {permissions, hardwareRequirements})`. Widen that method's signature to accept `hardwareRequirements?: HardwareRequirement[]`.
- Dev miniapps without `hardwareRequirements` in their manifest (pre-schema-update miniapps): fall back to `[]`. That means they'll show as compatible-by-default. Log a warning so developers notice.

**`mobile/src/services/LocalMiniappRuntime.ts`**:
- `ConnectedMiniapp.installedManifest` already has `permissions`. Add `hardwareRequirements`.
- Provide a read accessor (`getInstalledManifest(packageName)`) if one doesn't already exist, so the store can grab it when merging dev miniapps into the applets list. A simpler alternative: the `/applet/local` route already knows the package name at mount time — it can read it straight from `MiniappHost`'s pre-fetched manifest and push the `hardwareRequirements` directly onto the applet store entry when registering. I lean toward this simpler path to avoid coupling the runtime to the applets store.

### Part 3 — Phone reads `hardwareRequirements` for installed local miniapps

**`mobile/src/services/Composer.ts` — `getLocalApplets()`** (and `getLocalMiniAppHtml` for context):
- Wherever the local manifest JSON is parsed for installed miniapps, extract `hardwareRequirements` and include it on the returned applet objects. This is the one change that makes the existing `refreshApplets()` loop "just work" for installed local miniapps.
- If an installed manifest is missing `hardwareRequirements` (older/unsigned bundle), default to `[]` and log a warning. Don't crash.

### Part 4 — Inject `EXIST` requirement for local miniapps

Cloud does this at `applets.ts:714-717`:
```ts
hardwareRequirements: [...app.hardwareRequirements, {type: EXIST, level: REQUIRED}]
```
Local miniapps also need glasses to be meaningful (the whole point is rendering on them). Do the same:
- In `composer.getLocalApplets()` output, append `{type: EXIST, level: REQUIRED}` when building each entry.
- For dev miniapps registered via `/applet/local`, append it when pushing to the applets store.

Result: a local miniapp with no glasses connected shows the "Glasses Required" dialog just like cloud apps. No new code path needed — `startApplet` already branches on `EXIST`.

### Part 5 — `startApplet` path for local miniapps

Check that `startApplet()` in `applets.ts:789-833` doesn't have a `if (applet.local) { skip compat check }` short-circuit. From the grep, line 853 has `let shouldLoad = !applet.offline && !applet.local` — that's about whether to call the cloud to start the app, not about compatibility. The compat block at 807-833 runs first, unconditionally. So **no change needed** here; it will work once `.compatibility` is populated.

Worth confirming during implementation that nothing else in `startApplet` bypasses the compat check for local miniapps.

### Part 6 — Incompatible Apps bottom sheet

`mobile/src/components/home/IncompatibleApps.tsx:44-59` already lists any applet with `!compatibility?.isCompatible`. No change needed; local miniapps appear there automatically once they carry compatibility results.

---

## Files touched (estimated diff)

| File | Change |
|---|---|
| `sdk/miniapp-cli/src/manifest.ts` | Validate `hardwareRequirements` (required). Fix permissions validator loop. Export `MiniappManifestV1` type. |
| `sdk/miniapp/src/index.ts` (or wherever public exports live) | Re-export `HardwareRequirement`, `HardwareType`, `HardwareRequirementLevel`. |
| `sdk/example-miniapp/miniapp.json` | Add `hardwareRequirements`. |
| `sdk/create-mentra-miniapp/template/miniapp.json` | Add default `hardwareRequirements`. |
| `mobile/src/components/miniapp/MiniappHost.tsx` | `mountDev` extracts `hardwareRequirements` from the fetched manifest; passes through to `setInstalledManifest`. |
| `mobile/src/services/LocalMiniappRuntime.ts` | Widen `installedManifest` shape to include `hardwareRequirements`. |
| `mobile/src/services/Composer.ts` | `getLocalApplets()` extracts `hardwareRequirements` from installed bundles; appends `EXIST` requirement. |
| `mobile/src/app/applet/local.tsx` (dev-register path) | When registering a dev miniapp in the applets store, include `hardwareRequirements` + `EXIST`. |

**No changes to:**
- `AppIcon.tsx`, `IncompatibleApps.tsx`, `AppsGrid.tsx` — already correct.
- `applets.ts` `refreshApplets` compat loop and wearable subscription — already correct.
- `hardware.ts` compat function — already correct.
- Translations — reusing `home:hardwareIncompatible*` + `home:glassesRequired*` verbatim.

---

## Edge cases to handle

1. **Dev miniapp with no `miniapp.json` at the dev URL** — existing code already handles this with a `console.warn` and `manifestPerms = undefined`. Do the same for `hardwareRequirements`: default to `[]`, log warning.
2. **Installed local miniapp bundle from before this change** — manifest won't have `hardwareRequirements`. Default to `[]`, log once per package.
3. **`hardwareRequirements: []` explicitly** — allowed. Means the miniapp works on anything that has glasses connected (EXIST is auto-added).
4. **User switches from a G1 (has DISPLAY) to Simulated (has DISPLAY) to nothing (no glasses)** — `applets.ts:1047-1067` subscription fires on each change and recomputes `.compatibility` for every applet. Local miniapps inherit this for free.
5. **`hardwareRequirements` in manifest but malformed** — CLI validator catches it at build/pack time. Runtime fetch path (for dev) should log & skip malformed entries rather than crashing the whole miniapp launch.

---

## Tests

- **CLI validator** (`sdk/miniapp-cli/src/__tests__/manifest.test.ts` if it exists; otherwise add):
  - Missing `hardwareRequirements` → fail with clear message.
  - `hardwareRequirements: []` → pass.
  - Invalid `type` ("FOO") → fail, listing allowed values.
  - Invalid `level` ("MAYBE") → fail.
  - Malformed permission entries (the pre-existing bug) → fail, not pass.

- **Phone-side integration test (manual + mobile/test if feasible):**
  - Scan a dev miniapp that declares `DISPLAY REQUIRED` while connected to "no glasses" → icon greyed out, tap shows "Glasses Required".
  - Same miniapp with G1 connected → not greyed, launches normally.
  - Declare `CAMERA REQUIRED` + G1 connected (no camera) → greyed, tap shows "Hardware Incompatible, your glasses lack: camera".
  - Switch `default_wearable` from G1 to Mentra Live (has camera) while the miniapp is visible → compatibility flips without app restart.

---

## Rollout notes

- Making `hardwareRequirements` required is technically a breaking change for any in-flight local miniapps. Since local miniapps aren't shipped to users yet (this is pre-launch SDK work), this is the right time to make it mandatory. If someone already has a `miniapp.json` checked in without the field, `bun run pack` (or equivalent CLI step) will fail with a helpful message pointing them to the schema.
- Keep the CLI error message instructive: "hardwareRequirements is required. Example: [{type: 'DISPLAY', level: 'REQUIRED'}]. Allowed types: CAMERA, DISPLAY, MICROPHONE, SPEAKER, IMU, BUTTON, LIGHT, WIFI, EXIST."

---

## Out of scope (follow-ups)

- **`type` field** (`standard` / `background` / `system_dashboard`) — cloud has it, local doesn't. Punt until we need background local miniapps.
- **Optional-hw UI** — cloud doesn't treat `missingOptional` in any user-visible way today; we don't either. Revisit if/when we want "this app works better with X" messaging.
- **Install-time blocking** — no install flow yet for local miniapps (QR scan only). When an installable local miniapp store exists, mirror cloud's pre-install check there.
