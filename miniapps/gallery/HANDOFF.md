# Gallery miniapp — engineer handoff

A standalone MentraOS miniapp: a photo gallery for **Mentra Live** glasses, in an
editorial **white × cobalt** style. This doc is everything you need to take it over.

- **Branch:** `gallery-miniapp`
- **Package:** `com.parthawe.gallery` · **dev port:** 3280
- **Location:** `miniapps/gallery/`
- **Design source of truth:** Paper file "Engaging rain" —
  https://app.paper.design/file/01KVXY2GMGDSWQ8K0Y2H0GXTGP
  (gallery screens: Grid, Detail, Select, Empty, Settings)

---

## 1. Run & deploy

Prereqs: `bun`, this monorepo, and the Mentra phone app (v2.12+) with **Miniapp
Developer mode** enabled.

```bash
bun install                       # at repo root — registers the workspace
cd miniapps/gallery && bun run dev   # builds + serves on :3280, prints a QR
```

On the phone: **Settings → Developer settings → Mini App Development → Scan Mini
App QR Code**, scan the QR in your terminal.

- The QR uses the `miniapp://dev?...` scheme (current CLI). An older CLI emitted
  `mentra-miniapp://`, which the app rejects — make sure the CLI is current.
- **Wi-Fi flaky? Use the USB cable** (reliable): `adb reverse tcp:3280 tcp:3280`
  and `adb reverse tcp:3281 tcp:3281`, then scan a QR whose `url` is
  `http://127.0.0.1:3280` (the dev server prints the LAN IP by default — swap the
  host to `127.0.0.1` for the cable).
- Build only: `bun run build` → `dist/background/index.js` + `dist/ui/*`.

---

## 2. Architecture — new two-layer SDK

The miniapp is split across two runtimes that talk over a typed channel bus:

- **Background** (`src/background/`) — a per-miniapp JSContext (no DOM). Owns ALL
  glasses/host access via `session.*`. `GalleryController` is the whole app brain:
  capture, blob storage, favorites, settings, and the channel handlers. It lives
  for the session, surviving the UI opening/closing.
- **UI** (`src/ui/`) — a React WebView. Has **no** `session.*` access. It talks to
  background through the host-injected `mentra` global
  (`mentra.send` / `mentra.on` / `mentra.request`). A tiny module-level store
  (`src/ui/store/galleryStore.ts`) subscribes once and fans state out to React.
- **Channels** (`src/shared/channels.ts`) — imported by BOTH halves; the single
  source of truth for every message. `Rpc<…>` entries are request/response.
- **Build** (`build.ts`) — two Bun bundles: background as an **IIFE** (the
  JSContext evaluates a classic script, no ESM/DOM), UI with Tailwind v4 +
  `@mentra/miniapp-cli`'s `reactSingletonPlugin`.

SDK package: `@mentra/miniapp` at `mobile/modules/miniapp/`, sub-paths
`/background` (session) and `/ui` (mentra global + React hooks).

```
src/
  shared/        channels.ts (message registry) · types.ts (shared shapes)
  background/    index.ts (registerMiniapp) · controllers/GalleryController.ts
  ui/
    main.tsx     bootstrap (createRoot + MentraProvider + mentra.ready())
    App.tsx      HashRouter: / · /photo/:index · /settings · /settings/camera
    store/galleryStore.ts        channel subscription + commands
    hooks/usePhotoSrc.ts         resolves a photo's display src (url or gal:bytes)
    lib/format.ts, lib/cn.ts
    components/  Shell.tsx (safe-area, light/dark tone) · Thumb.tsx
    pages/       GridScreen · DetailScreen · SettingsScreen · CameraSettingsScreen
  index.css      Tailwind + @theme tokens + Red Hat Display @font-face
public/fonts/    Red Hat Display (bundled)
```

---

## 3. Data model & storage

- Each photo is one **blob** (`session.blob`). The library IS `blob.list()` — there
  is no separate index.
- **Capture flow:** `session.camera.takePhoto()` → short-TTL (~30 min) cloud URL →
  `blob.setFromUrl(key, url)` downloads the bytes host-side (they never cross the
  JS bridge) → durable on disk. `meta` carries `{createdAt, resolution, durationMs}`.
- **Display:** the WebView can't load a blob's `file://` uri, so the UI asks
  background for bytes via the `gal:bytes` RPC → base64 `data:` URL. A
  just-captured photo also carries its still-alive cloud `url` for an instant
  preview (`usePhotoSrc` prefers `url`, falls back to the RPC, memoizes results).
- **Favorites:** an id `Set` persisted in `session.storage` (`gallery:favorites`).
- **Settings:** `session.storage` key `gallery:settings` = `{saveToCameraRoll, photoSize}`.
- Storage is **scoped per packageName** — this app only ever sees its own captures.

---

## 4. Screens (all implemented & matched to Paper)

- **Grid** (`/`) — headline, `N PHOTOS · size`, Select, All/Photos/Videos pills,
  date-grouped 3-col grid, **scroll-aware edge fade** (photos dissolve under the
  header + beneath the Sync Gallery pill), video badges, capture FAB-less bottom
  **Sync Gallery** pill.
- **Detail** (`/photo/:index`) — near-black immersive viewer, big date + time,
  mono EXIF row (RES from the loaded image, SIZE, LENS ƒ/2.2, DEVICE Live),
  cobalt filmstrip, favorite heart, Share/Save/Delete.
- **Select** (in Grid) — long-press or "Select"; **ink** ring + check on chosen,
  Share/Favorite/Delete dock.
- **Empty** — Sync Gallery + outline "Capture a photo".
- **Settings** (`/settings`) — Camera Settings nav, Save-to-Camera-Roll toggle,
  Storage Info (photo/video counts, usage), Delete All (two-tap confirm). Photo
  resolution lives at `/settings/camera`.

Design tokens (in `src/index.css`): ground `#FFFFFF`, ink `#0B0E14`, muted
`#6A7282`, surface `#F4F5F8`, line `#E7E9EF`, night `#06080C`, cobalt `#1F45FF`.

---

## 5. ⚠️ Known gaps / TODO — READ THIS

These are SDK limitations, not bugs. The UI/data model are already wired for the
moment the APIs land.

1. **"Sync Gallery" does not actually sync from the glasses.** There is no SDK API
   to list or pull the glasses' on-device gallery. So "Sync Gallery" and the
   empty-state "Capture a photo" both currently call `takePhoto` (grab ONE fresh
   photo). To make it a real sync, add a glasses-gallery list/transfer API and
   rewire `GalleryController.capture` → a `sync` that pulls + `blob.setFromUrl`s
   each remote item.
2. **Videos render but can't be created yet.** The grid shows video tiles (play
   badge + duration), the Videos filter works, and `PhotoItem.durationMs` is
   plumbed — but `session.camera.startVideoRecording` records to the glasses with
   no retrieval-to-blob path. When that exists, store video blobs with
   `mimeType: "video/*"` + `meta.durationMs` and they appear automatically.
3. **Detail "Save" == "Share"** (both call `blob.share` → OS share sheet, which
   offers "Save to Photos"). There's no direct save-an-existing-blob-to-roll API;
   `saveToCameraRoll` only applies at capture time (the `saveToGallery` flag).
4. **No cross-app library.** A separate Camera app can't share photos with this
   Gallery (per-app blob storage). One library needs one app, or a shared/system
   gallery API.

---

## 6. Gotchas

- **Reserved package names.** `com.mentra.camera` and `com.mentra.gallery` are
  built-in packages (the native ASG gallery) — a dev miniapp using them collides
  with / overrides the built-in. Always use a custom namespace (this app:
  `com.parthawe.gallery`). See `mobile/src/constants/miniapps.ts` and
  `mobile/src/components/miniapp/offlineAppRegistry.ts`.
- **No plain-browser preview.** The UI needs the host-injected `mentra` global, so
  it white-screens in a normal browser. To preview, drop a throwaway `preview/`
  entry that sets `window.mentra` to a mock (responds to `gal:request-snapshot`
  with seeded photos, `gal:bytes` with picsum URLs) before rendering `<App/>`, and
  serve it via `Bun.serve`. Otherwise test on-device (dev server hot-reloads).
- **Host capsule.** The host renders a window-control capsule (top-right). Use
  `useSafeArea().capsuleMenu` to avoid overlapping it; the gallery leaves the
  top-right clear and puts only the settings gear top-left.
- **Always-light.** This app forces the editorial light surface (the Detail viewer
  is per-screen dark); `MentraProvider` is used with `syncColorScheme={false}`.
