/**
 * window.mentra — WebView-side bridge to the per-miniapp background JSContext.
 *
 * Injected into every UI WebView via `injectedJavaScriptBeforeContentLoaded`
 * (iOS) or `injectedJavaScriptObject` + a bundler-emitted inline `<script>`
 * (Android, where the `BeforeContentLoaded` prop is documented unreliable
 * per react-native-webview issues #1099 / #1609).
 *
 * The shim:
 *   - Buffers `mentra.send(channel, payload)` calls until `mentra.ready()`
 *     fires + the host acks the channel is open. WebView-side BUFFERS (the
 *     WebView is the short-lived side and shouldn't drop user input).
 *   - Installs `window.__mentra.recv(envelope)` for the host to push
 *     background → WebView messages via `webview.injectJavaScript(...)`.
 *   - Sends `__heartbeat__` every 5s; host considers the WebView gone
 *     after 15s of silence.
 *   - Maintains monotonic seq numbers; the host's per-WebView dedup window
 *     drops replays during reconnect.
 *
 * This file exports a `buildMentraUiShim()` function returning the JS
 * source as a string. The host's MentraUIRouter wraps it inside the
 * existing WebView setup so a single bundler-time string emission covers
 * both platforms.
 *
 * IMPORTANT: the shim runs in the WebView's bare ECMAScript scope before
 * the miniapp's bundle. It must not import anything; the source is one
 * IIFE. The only injected dependencies are
 * `window.ReactNativeWebView.postMessage` (provided by react-native-webview)
 * and (on Android) `window.ReactNativeWebView.injectedObjectJson()`
 * (provided when the host sets `injectedJavaScriptObject`).
 */

export interface MentraUiShimOptions {
  packageName: string
  /** @deprecated No longer used — heartbeat removed in Phase 3 (foreground-only WebViews). */
  heartbeatIntervalMs?: number
}

export function buildMentraUiShim(options: MentraUiShimOptions): string {
  const packageNameJson = JSON.stringify(options.packageName)
  // The IIFE assembles a typed `mentra` global plus an internal
  // `__mentra` for host inbound calls. Quoted strings are JSON-safe so
  // direct injection inside another JS literal also works.
  return `
(function () {
  if (typeof window === 'undefined') return;
  if (window.mentra && window.__mentra) return;
  var packageName = ${packageNameJson};
  var rnPost = null;
  try {
    rnPost = window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function'
      ? window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView)
      : null;
  } catch (e) { rnPost = null; }

  var outboundSeq = 1;
  var dedupRing = new Array(64);
  var dedupHead = 0;
  var ready = false;
  var channelHandlers = Object.create(null);
  var openHandlers = [];
  var closeHandlers = [];
  // Queued mentra.send calls before mentra.ready() acks. FIFO drained
  // on ack. Buffered so user input (button taps, etc.) isn't dropped
  // when the WebView mounts faster than the host expects.
  var outboundQueue = [];

  function postEnvelope(envelope) {
    if (!rnPost) return;
    try { rnPost(JSON.stringify(envelope)); } catch (_) {}
  }

  function send(channel, payload) {
    var seq = outboundSeq++;
    var envelope = { type: 'msg', seq: seq, channel: String(channel), payload: payload };
    if (!ready) {
      outboundQueue.push(envelope);
      return;
    }
    postEnvelope(envelope);
  }

  function flushQueue() {
    while (outboundQueue.length > 0) {
      postEnvelope(outboundQueue.shift());
    }
  }

  function on(channel, cb) {
    if (typeof cb !== 'function') return function () {};
    var list = channelHandlers[channel];
    if (!list) { list = []; channelHandlers[channel] = list; }
    list.push(cb);
    return function () {
      var idx = list.indexOf(cb);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  function onOpen(cb) {
    if (typeof cb !== 'function') return function () {};
    openHandlers.push(cb);
    if (ready) {
      try { cb(); } catch (e) {}
    }
    return function () {
      var idx = openHandlers.indexOf(cb);
      if (idx >= 0) openHandlers.splice(idx, 1);
    };
  }

  function onClose(cb) {
    if (typeof cb !== 'function') return function () {};
    closeHandlers.push(cb);
    return function () {
      var idx = closeHandlers.indexOf(cb);
      if (idx >= 0) closeHandlers.splice(idx, 1);
    };
  }

  function readyFn() {
    if (ready) return;
    ready = true;
    postEnvelope({ type: 'ready' });
    flushQueue();
    for (var i = 0; i < openHandlers.length; i++) {
      try { openHandlers[i](); } catch (e) {}
    }
  }

  function fireChannel(channel, payload) {
    var list = channelHandlers[channel];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) {}
    }
  }

  function recv(envelope) {
    if (!envelope || typeof envelope !== 'object') return;
    // Sequence dedup — drop duplicate seqs seen within the last 64
    // inbound messages so a reconnect-replay doesn't double-fire handlers.
    if (typeof envelope.seq === 'number') {
      for (var i = 0; i < dedupRing.length; i++) {
        if (dedupRing[i] === envelope.seq) return;
      }
      dedupRing[dedupHead] = envelope.seq;
      dedupHead = (dedupHead + 1) % dedupRing.length;
    }
    var type = envelope.type;
    if (type === 'msg' && typeof envelope.channel === 'string') {
      fireChannel(envelope.channel, envelope.payload);
      return;
    }
    if (type === 'open') {
      // Background side acknowledges the open. Fire onOpen handlers
      // again (idempotent — same shape as ready()'s fire).
      for (var j = 0; j < openHandlers.length; j++) {
        try { openHandlers[j](); } catch (e) {}
      }
      return;
    }
    if (type === 'close') {
      for (var k = 0; k < closeHandlers.length; k++) {
        try { closeHandlers[k](); } catch (e) {}
      }
      return;
    }
    if (type === 'ack') {
      // Reserved — currently unused on the WebView side.
      return;
    }
  }

  window.mentra = {
    send: send,
    on: on,
    onOpen: onOpen,
    onClose: onClose,
    ready: readyFn,
    /** @internal — packageName for diagnostic logs only. */
    _packageName: packageName,
  };
  window.__mentra = { recv: recv };
})();
`.trim()
}
