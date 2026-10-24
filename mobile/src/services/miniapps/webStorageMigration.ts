/**
 * Every miniapp screen's `localStorage`, kept by the host so it lasts like a normal app's, and the one-time move of
 * Mentra's own miniapps' data from the old shared `file://` store.
 *
 * Each miniapp's screen loads from its package's own origin (`miniapp://<packageName>` on iOS,
 * `https://<host>.miniapp.invalid` on Android). On iOS, WebKit's tracking prevention deletes an origin's
 * script-written storage when the origin had no user interaction in its last seven days of WebView use, at its next
 * pass, which runs soon after its network process starts; WKWebView has no public setting to stop it. So:
 *
 * 1. **The host's copy.** The engine keeps a copy of each package's `localStorage` (every key, up to 5 MB) in the
 *    package's data partition, beside its SDK storage (`miniappWebStorage.ts` in the engine, which also says what
 *    clears it). Every load of a screen gets a keeper script, injected before the miniapp's own scripts, that writes
 *    each kept key the origin lost (never overwriting one it has) and reports the keys it has that the copy lacks or
 *    holds differently (the origin's value wins); or, when the origin holds another account's or workspace's copy,
 *    replaces the origin's storage with the current one. It then reports every `setItem`, `removeItem` and `clear`,
 *    and, when the page is hidden, any value written another way (`localStorage.x = ...`). Removals are only ever
 *    taken from `removeItem` and `clear`, never inferred from a missing key, which may be WebKit's deletion.
 * 2. **The move.** Until Mentra 3.4 every miniapp's screen was a `file://` page, so every miniapp shared one web
 *    storage. The first open of a first-party miniapp listed below on its new origin reads that package's listed keys
 *    from the old store with a hidden page at a `file://` location, and adds them to the host's copy (never replacing
 *    what the page wrote since, never bringing back a key it removed). The page is the host's own HTML, written in a
 *    directory of its own; it is the only page that ever loads with file access, and it never runs a miniapp's code.
 *    The move copies: it never deletes or changes the old store, so a 3.3 build installed over this one still finds
 *    its data (without changes made since). A failed or interrupted move is retried at the next open, up to
 *    {@link MAX_WEB_STORAGE_MOVE_ATTEMPTS} attempts; after that the host logs the failure and the miniapp goes on
 *    without its old data. The move happens once per phone (its record outlives a logout), so a later account never
 *    gets an earlier one's old data. Third-party miniapps' old data can't be told apart, so nothing moves for them.
 *
 * Only `localStorage` is kept: `sessionStorage` lasts for one WebView, and IndexedDB, Cache Storage and cookies are
 * not kept (on iOS WebKit may delete them).
 */

import {Directory, File, Paths} from "expo-file-system"
import {createMMKV, type MMKV} from "react-native-mmkv"

import {
  applyMiniappWebStorageOps,
  cloudClientService,
  fillMiniappWebStorage,
  markMiniappWebStorageLoaded,
  markMiniappWebStorageOriginUnknown,
  miniappWebStorageEntries,
  openMiniappWebStorage,
  resolveMiniappDataPartition,
  type MiniappWebStorageOp,
  type MiniappWebStorageSession,
} from "@mentra/engine-host-internal"
import {storage} from "@/utils/storage"

/**
 * Each first-party miniapp's own `localStorage` keys in the old shared store, read from its source and its bundled
 * build: what the move copies. Mentra AI, Enterprise, Captions, Teleprompter, Translation, Recorder, Merge and Link
 * keep nothing in `localStorage` (some use session storage, which isn't kept).
 */
export const MOVED_WEB_STORAGE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "com.mentra.notes": [
    "onboarding-progress",
    "mentra_recent_searches",
    "mentra_recording_time_v2",
    "mentra-email-drawer-to",
    "mentra-email-drawer-cc",
    "mentra-email-drawer-remember-cc",
    "sega:forceMockData",
  ],
  "com.mentra.call": ["mentra-call.quota"],
  "com.mentra.livestreamer": [
    "livestreamer.videoQualitySettings",
    "livestreamer.webrtcVideoSettings",
    "livestreamer.developerMode",
  ],
  "com.mentra.navigation": ["nav:dev_override", "NavigationPage:dev"],
})

export const MAX_WEB_STORAGE_MOVE_ATTEMPTS = 3
/** How long a screen waits for the signed-in account before it opens without the host's copy. */
export const WEB_STORAGE_PARTITION_WAIT_MS = 5000

const READ_MESSAGE = "mentra_web_storage_read"
const CHANGE_MESSAGE = "mentra_web_storage_changed"
/** Session storage marker of a WebView whose first document already restored. */
const SESSION_MARK = "mentra:web-storage-restored"
const READER_DIRECTORY = "miniapp-web-storage-move"
/** Where the move is recorded, apart from the default MMKV instance that logout clears. */
export const WEB_STORAGE_MOVE_STORE_ID = "mentra-miniapp-web-storage-move"
/** How long the keeper gathers the page's changes before it reports them. */
const REPORT_DELAY_MS = 100

export const webStorageMovedKey = (packageName: string) => `moved:${packageName}`
export const webStorageMoveAttemptsKey = (packageName: string) => `attempts:${packageName}`
/** The records of Mentra 3.4's first builds, in the default MMKV instance. */
export const legacyWebStorageMovedKey = (packageName: string) => `miniapp_web_storage_moved:${packageName}`
export const legacyWebStorageMoveAttemptsKey = (packageName: string) =>
  `miniapp_web_storage_move_attempts:${packageName}`
/** Those builds' copy of a first-party package's listed keys: values, or null for a key the page removed. */
export const legacyKeptWebStorageKey = (packageName: string) => `miniapp_web_storage:${packageName}`

/** One attempt at moving a package's web storage. */
export interface WebStorageMove {
  packageName: string
  keys: readonly string[]
  /** 1-based; counted when the attempt begins, so an interrupted attempt counts. */
  attempt: number
  /** Ties the hidden page's message to this attempt. */
  nonce: string
}

/** What the hidden page read from the old store: only the package's listed keys that hold a value. */
export type WebStorageRead = {entries: Record<string, string>} | {error: string}

/** What a screen's page reported: that its keeper ran in the WebView's first document, and its changes in order. */
export interface WebStorageReport {
  loaded: boolean
  ops: MiniappWebStorageOp[]
}

/** One screen's link to the host's copy: its origin, the nonce its reports carry, and the copy they go to. */
export interface WebStorageKeeper {
  packageName: string
  origin: string
  nonce: string
  session: MiniappWebStorageSession
}

/** Packages whose give-up has been logged in this process. */
const gaveUpLogged = new Set<string>()
let moveStoreInstance: MMKV | undefined

function moveStore(): MMKV {
  return (moveStoreInstance ??= createMMKV({id: WEB_STORAGE_MOVE_STORE_ID}))
}

/** A first-party package whose old `file://` data moves to its origin. */
export function movesWebStorage(packageName: string): boolean {
  return Object.prototype.hasOwnProperty.call(MOVED_WEB_STORAGE_KEYS, packageName)
}

/** Takes over the move records of the first 3.4 builds, which logout cleared. */
function adoptLegacyMoveRecords(packageName: string): void {
  const moved = storage.load<unknown>(legacyWebStorageMovedKey(packageName))
  if (moved.is_ok()) {
    moveStore().set(webStorageMovedKey(packageName), String(Date.now()))
    storage.remove(legacyWebStorageMovedKey(packageName))
  }
  const attempts = storage.load<number>(legacyWebStorageMoveAttemptsKey(packageName))
  if (attempts.is_ok()) {
    if (Number.isInteger(attempts.value) && attempts.value > attemptsSoFar(packageName)) {
      moveStore().set(webStorageMoveAttemptsKey(packageName), String(attempts.value))
    }
    storage.remove(legacyWebStorageMoveAttemptsKey(packageName))
  }
}

export function isWebStorageMoved(packageName: string): boolean {
  adoptLegacyMoveRecords(packageName)
  return moveStore().getString(webStorageMovedKey(packageName)) !== undefined
}

function attemptsSoFar(packageName: string): number {
  const stored = Number(moveStore().getString(webStorageMoveAttemptsKey(packageName)))
  return Number.isInteger(stored) && stored > 0 ? stored : 0
}

function recordMoved(packageName: string): void {
  moveStore().set(webStorageMovedKey(packageName), String(Date.now()))
  moveStore().remove(webStorageMoveAttemptsKey(packageName))
}

export function newWebStorageNonce(): string {
  const bytes = new Uint8Array(16)
  const source = (globalThis as {crypto?: {getRandomValues?: (array: Uint8Array) => Uint8Array}}).crypto
  if (typeof source?.getRandomValues === "function") {
    source.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Starts an attempt at moving `packageName`'s web storage, or returns null when there is nothing to do: a package
 * with no listed keys, a development build, a package already moved, or one whose attempts are spent (which is then
 * recorded, so the host stops trying). Counts the attempt before anything runs.
 */
export function beginWebStorageMove(packageName: string, options: {devBuild: boolean}): WebStorageMove | null {
  const keys = MOVED_WEB_STORAGE_KEYS[packageName]
  if (!keys || options.devBuild || isWebStorageMoved(packageName)) return null
  const previous = attemptsSoFar(packageName)
  if (previous >= MAX_WEB_STORAGE_MOVE_ATTEMPTS) {
    if (!gaveUpLogged.has(packageName)) {
      gaveUpLogged.add(packageName)
      console.error(
        `WebStorageMove: ${packageName}'s web storage didn't move in ${previous} attempts; going on without its old data`,
      )
    }
    recordMoved(packageName)
    return null
  }
  const attempt = previous + 1
  moveStore().set(webStorageMoveAttemptsKey(packageName), String(attempt))
  return {packageName, keys, attempt, nonce: newWebStorageNonce()}
}

/**
 * The hidden page read the old store: the host's copy takes what it found for keys it knows nothing about. A key the
 * page wrote since (newer) or removed stays as it is. The move is done.
 */
export function completeWebStorageMove(
  move: WebStorageMove,
  entries: Record<string, string>,
  session: MiniappWebStorageSession,
): void {
  const listed: Record<string, string> = {}
  for (const key of move.keys) if (typeof entries[key] === "string") listed[key] = entries[key]
  fillMiniappWebStorage(session, listed)
  recordMoved(move.packageName)
  console.log(`WebStorageMove: moved ${move.packageName}'s web storage (${Object.keys(listed).length} keys)`)
}

/** The attempt failed; the next open retries until the attempts are spent. */
export function failWebStorageMove(move: WebStorageMove, reason: string): void {
  const last = move.attempt >= MAX_WEB_STORAGE_MOVE_ATTEMPTS
  console.warn(
    `WebStorageMove: moving ${move.packageName}'s web storage failed (attempt ${move.attempt} of ${MAX_WEB_STORAGE_MOVE_ATTEMPTS}): ${reason}` +
      (last ? "; giving up, so it goes on without its old data" : "; retrying at the next open"),
  )
}

/**
 * The first 3.4 builds kept a first-party package's listed keys apart from its partition. Their copy joins the
 * package's copy (filling only keys it knows nothing about, and remembering the removals it remembered), once.
 */
export function adoptLegacyKeptWebStorage(session: MiniappWebStorageSession): void {
  const key = legacyKeptWebStorageKey(session.packageName)
  const stored = storage.load<unknown>(key)
  if (!stored.is_ok()) return
  const entries: Record<string, string> = {}
  const removed: string[] = []
  const listed = MOVED_WEB_STORAGE_KEYS[session.packageName] ?? []
  if (stored.value && typeof stored.value === "object") {
    for (const name of listed) {
      const value = (stored.value as Record<string, unknown>)[name]
      if (typeof value === "string") entries[name] = value
      else if (value === null && Object.prototype.hasOwnProperty.call(stored.value, name)) removed.push(name)
    }
  }
  fillMiniappWebStorage(session, entries, removed)
  storage.remove(key)
}

/** JSON that is also safe inside an HTML `<script>` element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

/**
 * `postWhenBridged(message)` queues a JSON string for the WebView's bridge and
 * sends the queue in order once the bridge is there. Shared by the injected
 * page scripts; it refers to everything through `window` and captures the
 * timer when the script starts, before any page code runs.
 */
const BRIDGE_POSTER = `
  var later = window.setTimeout.bind(window);
  var outbox = [];
  var waiting = false;
  var waits = 0;
  function flushOutbox() {
    var bridge = window.ReactNativeWebView;
    if (!bridge || typeof bridge.postMessage !== "function") {
      if (!waiting && waits < 400) {
        waiting = true;
        waits++;
        later(function () { waiting = false; flushOutbox(); }, 50);
      }
      return;
    }
    while (outbox.length) {
      try { bridge.postMessage(outbox.shift()); } catch (e) {}
    }
  }
  function postWhenBridged(message) {
    outbox.push(message);
    flushOutbox();
  }`

/**
 * The hidden page: the host's own HTML, which reads only this package's listed
 * keys from the old shared `file://` store and posts them to the host. It loads
 * nothing and runs nothing else.
 */
export function webStorageReaderHtml(move: WebStorageMove): string {
  const script = `(function () {
  var NONCE = ${scriptJson(move.nonce)};
  var KEYS = ${scriptJson(move.keys)};
  var entries = {};
  var error = null;
  try {
    var store = window.localStorage;
    for (var i = 0; i < KEYS.length; i++) {
      var value = store.getItem(KEYS[i]);
      if (value !== null) entries[KEYS[i]] = value;
    }
  } catch (e) {
    error = String((e && e.message) || e);
  }
${BRIDGE_POSTER}
  postWhenBridged(JSON.stringify({type: ${scriptJson(READ_MESSAGE)}, nonce: NONCE, entries: entries, error: error}));
})();`
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
<title></title>
</head>
<body>
<script>
${script}
</script>
</body>
</html>
`
}

function readerDirectory(move: WebStorageMove): Directory {
  return new Directory(Paths.cache, READER_DIRECTORY, move.packageName)
}

/**
 * Writes the hidden page in a directory of its own, outside every bundle, and
 * returns its `file://` URL and that directory (the only read access it gets).
 */
export function writeWebStorageReader(move: WebStorageMove): {pageUri: string; directoryUri: string} {
  const directory = readerDirectory(move)
  if (directory.exists) directory.delete()
  directory.create({intermediates: true})
  const page = new File(directory, "read.html")
  page.write(webStorageReaderHtml(move))
  return {pageUri: page.uri, directoryUri: directory.uri}
}

export function removeWebStorageReader(move: WebStorageMove): void {
  try {
    const directory = readerDirectory(move)
    if (directory.exists) directory.delete()
  } catch (error) {
    console.warn(`WebStorageMove: couldn't remove ${move.packageName}'s reader page`, error)
  }
}

function parseMessage(raw: string, type: string, nonce: string): Record<string, unknown> | null {
  let message: unknown
  try {
    message = JSON.parse(raw)
  } catch {
    return null
  }
  if (!message || typeof message !== "object") return null
  const record = message as Record<string, unknown>
  return record.type === type && record.nonce === nonce ? record : null
}

/** What the hidden page posted for this attempt, or null for any other message. */
export function parseWebStorageRead(raw: string, move: WebStorageMove): WebStorageRead | null {
  const message = parseMessage(raw, READ_MESSAGE, move.nonce)
  if (!message) return null
  if (typeof message.error === "string" && message.error)
    return {error: `reading the old store failed: ${message.error}`}
  const rawEntries = message.entries
  if (!rawEntries || typeof rawEntries !== "object") return {error: "the reader posted no entries"}
  const entries: Record<string, string> = {}
  // Only the package's own listed keys, whatever the page claims.
  for (const key of move.keys) {
    const value = (rawEntries as Record<string, unknown>)[key]
    if (typeof value === "string") entries[key] = value
  }
  return {entries}
}

/**
 * The script injected at document start into every miniapp screen, before the miniapp's own scripts. In the top
 * frame of the screen's own origin only:
 *
 * - In the WebView's first document (`kept` is the copy as of when the WebView was set up, so a reload in the same
 *   WebView must not restore it again): in `replace` mode it clears the origin's `localStorage` first; then it writes
 *   each kept key the origin doesn't have, never overwriting one it has.
 * - It reports the keys the origin holds that the copy lacks or holds differently, then every `setItem`,
 *   `removeItem` and `clear` of `localStorage` (gathered for {@link REPORT_DELAY_MS}), and, when the page is hidden,
 *   values written without `setItem`. Session storage isn't reported. It leaves one marker in session storage.
 */
export function webStorageKeeperScript(keeper: WebStorageKeeper, kept: Record<string, string>): string {
  return `(function () {
  try {
    if (window.top !== window.self) return;
    if (window.location.origin !== ${scriptJson(keeper.origin)}) return;
  } catch (e) {
    return;
  }
  var NONCE = ${scriptJson(keeper.nonce)};
  var KEPT = JSON.parse(${scriptJson(JSON.stringify(kept))});
  var REPLACE = ${keeper.session.mode === "replace" ? "true" : "false"};
  var store;
  try { store = window.localStorage; } catch (e) { return; }
  if (!store) return;
  var proto = Object.getPrototypeOf(store);
  var getItem = proto.getItem, setItem = proto.setItem, removeItem = proto.removeItem, clear = proto.clear;
  var keyAt = proto.key;
  var lengthOf = Object.getOwnPropertyDescriptor(proto, "length");
  var own = Object.prototype.hasOwnProperty;
${BRIDGE_POSTER}
  var pending = [];
  var reportArmed = false;
  function send(loaded) {
    var message = {type: ${scriptJson(CHANGE_MESSAGE)}, nonce: NONCE, ops: pending};
    if (loaded) message.loaded = true;
    pending = [];
    postWhenBridged(JSON.stringify(message));
  }
  function reportNow() {
    if (pending.length) send(false);
  }
  function reportSoon() {
    if (reportArmed) return;
    reportArmed = true;
    later(function () { reportArmed = false; reportNow(); }, ${REPORT_DELAY_MS});
  }
  // Only the WebView's first document restores; session storage survives a reload in the same WebView.
  var firstDocument = true;
  var session = null;
  try {
    session = window.sessionStorage;
    if (session) {
      firstDocument = getItem.call(session, ${scriptJson(SESSION_MARK)}) === null;
      if (firstDocument) setItem.call(session, ${scriptJson(SESSION_MARK)}, "1");
    }
  } catch (e) {}
  // What the host's copy holds, as far as this page knows.
  var known = Object.create(null);
  var keptKeys = Object.keys(KEPT);
  for (var k = 0; k < keptKeys.length; k++) known[keptKeys[k]] = KEPT[keptKeys[k]];
  if (firstDocument) {
    // Another copy's data (another account's or workspace's) never reaches this page.
    if (REPLACE) { try { clear.call(store); } catch (e) {} }
    // What the host kept and this origin lost (WebKit may have deleted it).
    for (var r = 0; r < keptKeys.length; r++) {
      var name = keptKeys[r];
      var current = null;
      try { current = getItem.call(store, name); } catch (e) {}
      if (current === null) {
        try { setItem.call(store, name, KEPT[name]); } catch (e) {}
      }
    }
  }
  // What this origin has that the copy doesn't (the origin's value wins). Removals are never inferred.
  function takeOriginValues() {
    var count = 0;
    try { count = lengthOf && lengthOf.get ? lengthOf.get.call(store) : store.length; } catch (e) { return; }
    for (var i = 0; i < count; i++) {
      var key = null, value = null;
      try { key = keyAt.call(store, i); } catch (e) {}
      if (key === null || key === undefined) continue;
      try { value = getItem.call(store, key); } catch (e) {}
      if (value !== null && (!own.call(known, key) || known[key] !== value)) {
        known[key] = value;
        pending.push(["set", key, value]);
      }
    }
  }
  takeOriginValues();
  if (firstDocument) send(true);
  else reportNow();
  proto.setItem = function (name, value) {
    var result = setItem.apply(this, arguments);
    if (this === store) {
      var key = String(name);
      var stored = getItem.call(store, key);
      if (stored !== null) {
        known[key] = stored;
        pending.push(["set", key, stored]);
        reportSoon();
      }
    }
    return result;
  };
  proto.removeItem = function (name) {
    // The first-document marker stays, so the page's own session storage calls never re-arm the restore.
    if (session && this === session && String(name) === ${scriptJson(SESSION_MARK)}) return;
    var result = removeItem.apply(this, arguments);
    if (this === store) {
      var key = String(name);
      delete known[key];
      pending.push(["remove", key]);
      reportSoon();
    }
    return result;
  };
  proto.clear = function () {
    var result = clear.apply(this, arguments);
    if (session && this === session) {
      try { setItem.call(session, ${scriptJson(SESSION_MARK)}, "1"); } catch (e) {}
    }
    if (this === store) {
      known = Object.create(null);
      pending.push(["clear"]);
      reportSoon();
    }
    return result;
  };
  function onHidden() {
    takeOriginValues();
    reportNow();
  }
  try {
    window.addEventListener("pagehide", onHidden);
    var doc = window.document;
    if (doc) {
      doc.addEventListener("visibilitychange", function () {
        if (doc.visibilityState === "hidden") onHidden();
      });
    }
  } catch (e) {}
})();`
}

/**
 * The script a screen gets when no account is known: in the WebView's first document, in the top frame of the
 * screen's own origin, it empties `localStorage` before the miniapp's scripts run, so the page never sees data
 * whose owner the host can't tell (an earlier account's, which logout leaves in WebKit). The host's copies are
 * untouched. Nothing is reported.
 */
export function webStorageIsolationScript(origin: string): string {
  return `(function () {
  try {
    if (window.top !== window.self) return;
    if (window.location.origin !== ${scriptJson(origin)}) return;
    var session = window.sessionStorage;
    if (session) {
      if (session.getItem(${scriptJson(SESSION_MARK)}) !== null) return;
      session.setItem(${scriptJson(SESSION_MARK)}, "1");
    }
    window.localStorage.clear();
  } catch (e) {}
})();`
}

function parseOp(raw: unknown): MiniappWebStorageOp | null {
  if (!Array.isArray(raw)) return null
  if (raw[0] === "clear" && raw.length === 1) return ["clear"]
  if (raw[0] === "remove" && raw.length === 2 && typeof raw[1] === "string") return ["remove", raw[1]]
  if (raw[0] === "set" && raw.length === 3 && typeof raw[1] === "string" && typeof raw[2] === "string")
    return ["set", raw[1], raw[2]]
  return null
}

/** What this screen's page reported, or null for any other message (another screen's nonce included). */
export function parseWebStorageReport(raw: string, keeper: WebStorageKeeper): WebStorageReport | null {
  const message = parseMessage(raw, CHANGE_MESSAGE, keeper.nonce)
  if (!message) return null
  const ops: MiniappWebStorageOp[] = []
  if (Array.isArray(message.ops)) {
    for (const entry of message.ops) {
      const op = parseOp(entry)
      if (op) ops.push(op)
    }
  }
  return {loaded: message.loaded === true, ops}
}

/** Applies a screen's report to its package's copy. */
export function applyWebStorageReport(keeper: WebStorageKeeper, report: WebStorageReport): void {
  if (report.loaded) markMiniappWebStorageLoaded(keeper.session)
  applyMiniappWebStorageOps(keeper.session, report.ops)
}

/**
 * A screen whose keeper replaced its origin's storage reported its load: later documents in the same WebView get a
 * keeper that merges the copy as it is now, so a page that clears its session storage (the keeper's first-document
 * marker) and reloads never gets the replace again.
 */
export function webStorageKeeperAfterLoad(keeper: WebStorageKeeper): {keeper: WebStorageKeeper; script: string} {
  const next: WebStorageKeeper = {...keeper, session: {...keeper.session, mode: "merge"}}
  return {keeper: next, script: webStorageKeeperScript(next, miniappWebStorageEntries(keeper.session))}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** The data partition `packageName`'s screen keeps its copy in, once the signed-in account is known; else null. */
export async function webStoragePartitionId(packageName: string): Promise<string | null> {
  try {
    return resolveMiniappDataPartition(packageName).id
  } catch {
    // The account isn't known yet: wait for it, as SDK storage does, but not for long.
  }
  try {
    await withTimeout(cloudClientService.resolveMentraUserId(), WEB_STORAGE_PARTITION_WAIT_MS)
    return resolveMiniappDataPartition(packageName).id
  } catch (error) {
    console.warn(`WebStorage: ${packageName}'s screen opens without the host's copy (no account yet)`, error)
    return null
  }
}

/**
 * Sets up a screen's link to its package's copy: the copy for its data partition, the move of a first-party
 * package's old data (with `readOldStore`, before the page loads), and the keeper script with the copy as it is now.
 * Reuses `previous`'s nonce for the same copy and origin, so the page still showing keeps reporting. When no account
 * is known, there is no keeper, and the script empties the origin's `localStorage` before the page runs (see
 * {@link webStorageIsolationScript}); its next load with an account gets that account's copy.
 */
export async function openWebStorageKeeper(input: {
  packageName: string
  origin: string
  devBuild: boolean
  previous: WebStorageKeeper | null
  readOldStore: (move: WebStorageMove) => Promise<WebStorageRead>
  /** Throws when the launch was superseded. */
  checkpoint: () => void
}): Promise<{keeper: WebStorageKeeper | null; script: string}> {
  const {packageName, origin, devBuild, previous} = input
  const partitionId = await webStoragePartitionId(packageName)
  input.checkpoint()
  if (!partitionId) {
    // Whose data the origin holds is unknown (another account's, after a logout), so the page starts empty and the
    // next load with an account replaces it with that account's copy.
    markMiniappWebStorageOriginUnknown(origin)
    return {keeper: null, script: webStorageIsolationScript(origin)}
  }
  const listed = !devBuild ? MOVED_WEB_STORAGE_KEYS[packageName] : undefined
  const session = openMiniappWebStorage({packageName, origin, partitionId, rememberRemoved: listed ?? []})
  if (listed) {
    adoptLegacyKeptWebStorage(session)
    const move = beginWebStorageMove(packageName, {devBuild})
    if (move) {
      const read = await input.readOldStore(move)
      input.checkpoint()
      if ("error" in read) failWebStorageMove(move, read.error)
      else completeWebStorageMove(move, read.entries, session)
    }
  }
  const same =
    previous !== null &&
    previous.origin === origin &&
    previous.session.packageName === packageName &&
    previous.session.partitionId === partitionId &&
    previous.session.copyId === session.copyId
  const keeper: WebStorageKeeper = {packageName, origin, nonce: same ? previous.nonce : newWebStorageNonce(), session}
  return {keeper, script: webStorageKeeperScript(keeper, miniappWebStorageEntries(session))}
}

/** Test seam: forget this process's logs. */
export function resetWebStorageMoveStateForTests(): void {
  gaveUpLogged.clear()
  moveStoreInstance?.clearAll()
}
