/**
 * Moving Mentra's own miniapps' web storage to their own origins, and keeping
 * it there.
 *
 * Until Mentra 3.4 every miniapp's screen was a `file://` page, so every
 * miniapp shared one web storage. Each screen now loads from its package's own
 * origin (`miniapp://<packageName>` on iOS, `https://<host>.miniapp.invalid` on
 * Android), which starts empty. For the first-party miniapps listed below:
 *
 * 1. **The move.** The first open on the new origin reads the package's listed
 *    `localStorage` keys from the old shared store with a hidden page at a
 *    `file://` location, and the host keeps them. The page is the host's own
 *    HTML, written in a directory of its own; it is the only page that ever
 *    loads with file access, and it never runs a miniapp's code.
 * 2. **The host's copy.** Every load of the package's screen gets a script,
 *    injected before the miniapp's own scripts, that writes each kept key the
 *    origin doesn't have (never overwriting one it has), reports the listed
 *    keys the origin has with other values (the origin's value wins), then
 *    reports every later `setItem`, `removeItem` and `clear` of a listed key
 *    so the host's copy follows the page. The copy remembers keys the page
 *    removed, so neither a restore nor a later move brings them back.
 *
 * Why the host keeps a copy: on iOS, WebKit's tracking prevention deletes an
 * origin's script-written storage (localStorage, IndexedDB) when the origin has
 * had no user interaction within its last seven days of WebView use, at its
 * next pass, which runs soon after its network process starts. `file://` pages
 * have no domain and were exempt, so the 3.3 store never went away. With the
 * host's copy, a miniapp's listed keys come back at its next load, including
 * every change it made since the move, and keys it removed stay removed.
 *
 * The move copies. It never deletes or changes the old store, so a 3.3 build
 * installed over this one still finds its data (without changes made since). A
 * key already on the new origin is never overwritten. A failed or interrupted
 * move is retried at the next open, up to {@link MAX_WEB_STORAGE_MOVE_ATTEMPTS}
 * attempts; after that the host logs the failure and the miniapp goes on
 * without its old data. Only the listed keys are kept: session storage isn't,
 * nothing is for development builds, and third-party miniapps get nothing.
 */

import {Directory, File, Paths} from "expo-file-system"

import {storage} from "@/utils/storage"

/**
 * Each first-party miniapp's own `localStorage` keys, read from its source and
 * its bundled build. Mentra AI, Enterprise, Captions, Teleprompter,
 * Translation, Recorder, Merge and Link keep nothing in `localStorage` (some
 * use session storage, which isn't kept). A listed miniapp must use
 * `localStorage.setItem`, `removeItem` and `clear` for these keys (not property
 * assignment) for the host's copy to follow it.
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

const READ_MESSAGE = "mentra_web_storage_read"
const CHANGE_MESSAGE = "mentra_web_storage_changed"
/** Session storage marker of a WebView whose first document already restored. */
const SESSION_MARK = "mentra:web-storage-restored"
const READER_DIRECTORY = "miniapp-web-storage-move"

export const webStorageMovedKey = (packageName: string) => `miniapp_web_storage_moved:${packageName}`
export const webStorageMoveAttemptsKey = (packageName: string) => `miniapp_web_storage_move_attempts:${packageName}`
/**
 * The host's copy of a package's listed keys: a JSON object whose values are
 * strings, or null for a key the page removed (so the move never refills it).
 */
export const keptWebStorageKey = (packageName: string) => `miniapp_web_storage:${packageName}`

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

/** A change the package's page made to its listed keys, in order: clear, then removals, then writes. */
export interface WebStorageChange {
  clear: boolean
  remove: string[]
  set: Record<string, string>
}

/** One screen's link to the host's copy: its package, its origin and the nonce its reports carry. */
export interface WebStorageKeeper {
  packageName: string
  origin: string
  nonce: string
}

/** Packages whose give-up has been logged in this process. */
const gaveUpLogged = new Set<string>()

/** True for a package whose web storage the host keeps. */
export function keepsWebStorage(packageName: string): boolean {
  return Object.prototype.hasOwnProperty.call(MOVED_WEB_STORAGE_KEYS, packageName)
}

export function isWebStorageMoved(packageName: string): boolean {
  return storage.load<unknown>(webStorageMovedKey(packageName)).is_ok()
}

/** Every listed key the host knows about: its value, or null when the page removed it. */
function keptState(packageName: string): Record<string, string | null> {
  const keys = MOVED_WEB_STORAGE_KEYS[packageName] ?? []
  const stored = storage.load<unknown>(keptWebStorageKey(packageName))
  const state: Record<string, string | null> = {}
  if (stored.is_ok() && stored.value && typeof stored.value === "object") {
    for (const key of keys) {
      const value = (stored.value as Record<string, unknown>)[key]
      if (typeof value === "string" || value === null) state[key] = value
    }
  }
  return state
}

/** The host's copy of `packageName`'s listed keys that hold a value (empty before anything is kept). */
export function keptWebStorage(packageName: string): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(keptState(packageName))) if (value !== null) kept[key] = value
  return kept
}

function saveKept(packageName: string, state: Record<string, string | null>): void {
  storage.save(keptWebStorageKey(packageName), state)
}

function attemptsSoFar(packageName: string): number {
  const stored = storage.load<number>(webStorageMoveAttemptsKey(packageName))
  return stored.is_ok() && Number.isInteger(stored.value) && stored.value > 0 ? stored.value : 0
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
 * Starts an attempt at moving `packageName`'s web storage, or returns null when
 * there is nothing to do: a package with no listed keys, a development build,
 * a package already moved, or one whose attempts are spent (which is then
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
    storage.save(webStorageMovedKey(packageName), Date.now())
    storage.remove(webStorageMoveAttemptsKey(packageName))
    return null
  }
  const attempt = previous + 1
  storage.save(webStorageMoveAttemptsKey(packageName), attempt)
  return {packageName, keys, attempt, nonce: newWebStorageNonce()}
}

/**
 * The hidden page read the old store: the host keeps what it found for keys it
 * knows nothing about. A key it already keeps (newer) or that the page removed
 * stays as it is. The move is done.
 */
export function completeWebStorageMove(move: WebStorageMove, entries: Record<string, string>): void {
  const state = keptState(move.packageName)
  for (const key of move.keys) {
    if (typeof entries[key] === "string" && !(key in state)) state[key] = entries[key]
  }
  saveKept(move.packageName, state)
  storage.save(webStorageMovedKey(move.packageName), Date.now())
  storage.remove(webStorageMoveAttemptsKey(move.packageName))
  console.log(`WebStorageMove: moved ${move.packageName}'s web storage (${Object.keys(entries).length} keys)`)
}

/** The attempt failed; the next open retries until the attempts are spent. */
export function failWebStorageMove(move: WebStorageMove, reason: string): void {
  const last = move.attempt >= MAX_WEB_STORAGE_MOVE_ATTEMPTS
  console.warn(
    `WebStorageMove: moving ${move.packageName}'s web storage failed (attempt ${move.attempt} of ${MAX_WEB_STORAGE_MOVE_ATTEMPTS}): ${reason}` +
      (last ? "; giving up, so it goes on without its old data" : "; retrying at the next open"),
  )
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
 * The script injected at document start into a listed package's origin,
 * before the miniapp's own scripts. In the top frame of the package's own
 * origin only, it writes each key the host keeps that the origin doesn't have
 * (never overwriting; only in the WebView's first document, since `kept` is
 * the copy as of when the WebView was set up), reports listed keys the origin
 * holds with other values, then reports every `setItem`, `removeItem` and
 * `clear` of a listed `localStorage` key (session storage and other keys
 * aren't reported). It leaves one marker in session storage.
 */
export function webStorageKeeperScript(keeper: WebStorageKeeper, kept: Record<string, string>): string {
  const keys = MOVED_WEB_STORAGE_KEYS[keeper.packageName] ?? []
  return `(function () {
  try {
    if (window.top !== window.self) return;
    if (window.location.origin !== ${scriptJson(keeper.origin)}) return;
  } catch (e) {
    return;
  }
  var NONCE = ${scriptJson(keeper.nonce)};
  var KEYS = ${scriptJson(keys)};
  var KEPT = ${scriptJson(kept)};
  var store;
  try { store = window.localStorage; } catch (e) { return; }
  if (!store) return;
  var proto = Object.getPrototypeOf(store);
  var getItem = proto.getItem, setItem = proto.setItem, removeItem = proto.removeItem, clear = proto.clear;
  var listed = {};
  for (var i = 0; i < KEYS.length; i++) listed[KEYS[i]] = true;
${BRIDGE_POSTER}
  function report(change) {
    change.type = ${scriptJson(CHANGE_MESSAGE)};
    change.nonce = NONCE;
    postWhenBridged(JSON.stringify(change));
  }
  // Only the WebView's first document restores. KEPT is the host's copy as of
  // when this WebView was set up; a reload in the same WebView (session storage
  // survives it) must not bring back what the page removed since.
  var firstDocument = true;
  try {
    var session = window.sessionStorage;
    if (session) {
      firstDocument = getItem.call(session, ${scriptJson(SESSION_MARK)}) === null;
      if (firstDocument) setItem.call(session, ${scriptJson(SESSION_MARK)}, "1");
    }
  } catch (e) {}
  // What the host kept and this origin lost (WebKit may have deleted it), and
  // what this origin has that the host doesn't know (the origin's value wins).
  var known = {};
  var knownCount = 0;
  for (var k = 0; k < KEYS.length; k++) {
    var key = KEYS[k];
    var kept = Object.prototype.hasOwnProperty.call(KEPT, key) ? KEPT[key] : null;
    var value = null;
    try { value = getItem.call(store, key); } catch (e) {}
    if (value === null && kept !== null) {
      if (firstDocument) {
        try { setItem.call(store, key, kept); } catch (e) {}
      }
    } else if (value !== null && value !== kept) {
      known[key] = value;
      knownCount++;
    }
  }
  if (knownCount > 0) report({set: known});
  proto.setItem = function (name, value) {
    var result = setItem.apply(this, arguments);
    var key = String(name);
    if (this === store && listed[key] === true) {
      var set = {};
      set[key] = getItem.call(store, key);
      report({set: set});
    }
    return result;
  };
  proto.removeItem = function (name) {
    var result = removeItem.apply(this, arguments);
    var key = String(name);
    if (this === store && listed[key] === true) report({remove: [key]});
    return result;
  };
  proto.clear = function () {
    var result = clear.apply(this, arguments);
    if (this === store) report({clear: true});
    return result;
  };
})();`
}

/** A change this screen's page reported, limited to the package's listed keys, or null for any other message. */
export function parseWebStorageChange(raw: string, keeper: WebStorageKeeper): WebStorageChange | null {
  const message = parseMessage(raw, CHANGE_MESSAGE, keeper.nonce)
  if (!message) return null
  const keys = MOVED_WEB_STORAGE_KEYS[keeper.packageName] ?? []
  const set: Record<string, string> = {}
  if (message.set && typeof message.set === "object") {
    for (const [key, value] of Object.entries(message.set as Record<string, unknown>)) {
      if (keys.includes(key) && typeof value === "string") set[key] = value
    }
  }
  const remove = Array.isArray(message.remove)
    ? message.remove.filter((key): key is string => typeof key === "string" && keys.includes(key))
    : []
  return {clear: message.clear === true, remove, set}
}

/** Applies a change from the package's page to the host's copy; a removed key is remembered as removed. */
export function applyWebStorageChange(packageName: string, change: WebStorageChange): void {
  const state = keptState(packageName)
  if (change.clear) for (const key of MOVED_WEB_STORAGE_KEYS[packageName] ?? []) state[key] = null
  for (const key of change.remove) state[key] = null
  Object.assign(state, change.set)
  saveKept(packageName, state)
}

/** Test seam: forget this process's logs. */
export function resetWebStorageMoveStateForTests(): void {
  gaveUpLogged.clear()
}
