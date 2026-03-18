# 037: Saved URL Bookmarks for Backend & Store URLs

## Overview

**What this doc covers:** Spec and design for persisted "bookmark" lists on the developer settings Custom Backend URL and Custom Store URL components, so developers can save and recall personal URLs with one tap instead of retyping them every time.

**Why this doc exists:** The current developer URL components have hardcoded environment preset buttons (Global, Dev, Staging, etc.) that are useful for everyone, but there's no way to save personal URLs like `isaiah.augmentos.cloud` or a Tailscale funnel URL. Every time you switch to a local dev setup, you retype the full URL. This is a daily pain point for anyone doing local cloud + store development.

**Who should read this:** Mobile engineers working on the developer settings UI.

---

## The Problem in 30 Seconds

1. `BackendUrl.tsx` and `StoreUrl.tsx` each have a text input and a set of hardcoded environment buttons (Global, Dev, Debug, US Central, France, Asia East, Staging / Global, Beta, Dev).
2. If you want to use a personal URL — your ngrok tunnel, your Tailscale funnel, your local IP — you type it out from scratch every single time.
3. The URL you typed last session is gone. The setting itself persists (the _active_ URL stays), but if you switch between environments frequently, you're retyping URLs you've used dozens of times.

---

## Spec

### New settings

Two new entries in the `SETTINGS` record in `mobile/src/stores/settings.ts`:

| Key                  | Type                                  | Default | Persist | Save on Server |
| -------------------- | ------------------------------------- | ------- | ------- | -------------- |
| `saved_backend_urls` | `Array<{label: string, url: string}>` | `[]`    | `true`  | `false`        |
| `saved_store_urls`   | `Array<{label: string, url: string}>` | `[]`    | `true`  | `false`        |

These are local-only developer conveniences. They never leave the device.

### Label generation

When a user bookmarks a URL, the label is **auto-generated from the hostname**:

| URL                                  | Auto-label                   |
| ------------------------------------ | ---------------------------- |
| `https://isaiah.augmentos.cloud:443` | `isaiah.augmentos.cloud`     |
| `https://my-machine.tail1234.ts.net` | `my-machine.tail1234.ts.net` |
| `http://192.168.1.100:7002`          | `192.168.1.100:7002`         |
| `https://apps.mentra.glass`          | `apps.mentra.glass`          |

Rule: `new URL(input).host` — includes port if non-standard, strips protocol and path. Simple, recognizable, no prompt dialog needed.

### User interactions

| Action                         | Behavior                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tap **"☆ Bookmark"** button    | Saves the current text input URL to the persisted bookmark list with an auto-generated label. Shows a brief alert confirming the save. Duplicate URLs are rejected with a message. |
| Tap a **bookmark chip**        | Fills the text input with that bookmark's URL (does NOT auto-apply — user still hits "Save & Test" / "Save URL" to activate it).                                                   |
| Long-press a **bookmark chip** | Shows a confirmation alert, then removes the bookmark from the persisted list.                                                                                                     |

### What does NOT change

- The existing hardcoded environment buttons (Global, Dev, Staging, etc.) stay exactly as-is.
- The "Save & Test URL" / "Save URL" flow is unchanged — bookmarks only fill the text input, they don't auto-apply.
- The "Reset" button behavior is unchanged.
- No new screens, modals, or navigation routes.

---

## Design

### Changes summary

| #   | File                                       | Change                                                        |
| --- | ------------------------------------------ | ------------------------------------------------------------- |
| 1   | `mobile/src/stores/settings.ts`            | Add `saved_backend_urls` and `saved_store_urls` setting defs  |
| 2   | `mobile/src/components/dev/BackendUrl.tsx` | Add bookmark button, saved URLs section, long-press to delete |
| 3   | `mobile/src/components/dev/StoreUrl.tsx`   | Same treatment as BackendUrl                                  |

### Change 1: Settings definitions

Add to the `SETTINGS` record, after `store_url`:

```typescript
saved_backend_urls: {
  key: "saved_backend_urls",
  defaultValue: () => [],
  writable: true,
  saveOnServer: false,
  persist: true,
},
saved_store_urls: {
  key: "saved_store_urls",
  defaultValue: () => [],
  writable: true,
  saveOnServer: false,
  persist: true,
},
```

These are arrays serialized to JSON via MMKV — the existing `storage.save()` already handles `JSON.stringify` on any value, so arrays work out of the box.

### Change 2 & 3: Component UI updates

Both `BackendUrl.tsx` and `StoreUrl.tsx` get the same structural additions:

#### New state / hooks

```typescript
const [savedUrls, setSavedUrls] = useSetting(SETTINGS.saved_backend_urls.key)
// (or saved_store_urls for StoreUrl)
```

#### "☆ Bookmark" button

Added to the existing button row next to "Save & Test URL" and "Reset". When pressed:

1. Validate the text input (non-empty, starts with `http://` or `https://`)
2. Check for duplicates in `savedUrls`
3. Auto-generate label via `new URL(url).host`
4. Append `{label, url}` to the array
5. Persist via `setSavedUrls([...savedUrls, {label, url}])`
6. Show brief confirmation alert

#### "My URLs" section

Rendered between the text input area and the environment preset buttons. Only shown when `savedUrls.length > 0`.

Each bookmark renders as a compact tappable chip showing the label text:

- **Tap**: fills the text input with the URL
- **Long-press**: shows a confirmation alert ("Remove bookmark [label]?"), then filters it out of the array and persists

#### Layout

```
┌─────────────────────────────────────────┐
│ Custom Backend URL                      │
│ Override the default backend server...  │
│ Currently using: https://...            │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ e.g., http://192.168.1.100:7002     │ │ ← existing text input
│ └─────────────────────────────────────┘ │
│                                         │
│ [Save & Test URL]  [Reset]  [☆ Bookmark]│ ← bookmark button added
│                                         │
│ ── My URLs ──────────────────────────── │ ← new section (if any saved)
│ [isaiah.augmentos.cloud] [192.168.1.42] │ ← tappable chips
│ [my-machine.ts.net]                     │
│                                         │
│ ── Environments ─────────────────────── │ ← existing preset buttons
│ [Global]  [Dev]                         │
│ [Debug]   [US Central]                  │
│ [France]  [Asia East]                   │
│ [Staging]                               │
└─────────────────────────────────────────┘
```

### Chip styling

Chips use the existing theme tokens to stay consistent:

- Background: `colors.background` (same as the text input background)
- Border: `colors.primary` with border-radius matching existing buttons
- Text: `colors.text`, small font (12-13px)
- Use `TouchableOpacity` for tap + `onLongPress` prop for delete

---

## Edge Cases

| Scenario                                      | Behavior                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Bookmark a URL that's already saved           | Show alert: "Already bookmarked". Don't add duplicate.                                                                       |
| Text input is empty when hitting "☆ Bookmark" | Show alert: "Enter a URL first".                                                                                             |
| URL is invalid (no http/https)                | Show alert: same validation as existing "Save & Test".                                                                       |
| Saved URLs array is corrupted in storage      | `defaultValue: () => []` handles this — MMKV parse failure falls back to default.                                            |
| Many bookmarks (10+)                          | The chip section wraps with `flexWrap: "wrap"`. No hard limit needed — this is a dev tool, unlikely to have more than ~5-10. |

---

## Testing

### Manual verification

1. Open Developer Settings → Custom Backend URL
2. Type a URL like `https://isaiah.augmentos.cloud:443`
3. Tap "☆ Bookmark" → should see confirmation, chip appears in "My URLs"
4. Clear the text input, tap the chip → text input fills with the URL
5. Long-press the chip → confirmation dialog → chip removed
6. Kill and relaunch the app → chip should still be there (MMKV persistence)
7. Repeat for Custom Store URL section

### Verify no regressions

- "Save & Test URL" still works as before
- "Reset" still clears to default
- Environment preset buttons still fill the text input
- Bookmarks don't affect the active URL — they only fill the text input
