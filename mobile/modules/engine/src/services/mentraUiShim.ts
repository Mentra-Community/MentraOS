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
  /** @deprecated No longer used — heartbeat removed since WebViews are foreground-only. */
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
  // Resolve window.ReactNativeWebView.postMessage LAZILY, not once at shim-eval.
  // On Android the shim is injected as a WebViewCompat document-start script
  // (so it beats the page bundle and the ready handshake can't be raced — see
  // the react-native-webview patch). But the order in which that document-start
  // script runs vs. the WebMessageListener that installs
  // window.ReactNativeWebView is not contractually fixed on Android the way it
  // is on iOS (postMessageScript is registered before atStartScript there). If
  // we captured rnPost once and the bridge object wasn't installed yet, every
  // postMessage — including {type:'ready'} — would be silently dropped and the
  // splash would hang forever. Resolving per-call means we always pick up the
  // bridge once it exists, which it reliably does by the time the bundle mounts
  // and calls mentra.ready().
  function getRnPost() {
    try {
      return window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function'
        ? window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView)
        : null;
    } catch (e) { return null; }
  }

  // Outbound seq number — purely a log-correlation aid (the host's
  // router doesn't dedup anymore since reconnect can't happen: one
  // WebView, foreground-only, destroyed on close → fresh shim on
  // next open).
  var outboundSeq = 1;
  var ready = false;
  var channelHandlers = Object.create(null);
  var openHandlers = [];
  var closeHandlers = [];
  // Queued mentra.send calls before mentra.ready() acks. FIFO drained
  // on ack. Buffered so user input (button taps, etc.) isn't dropped
  // when the WebView mounts faster than the host expects.
  var outboundQueue = [];
  // Inbound payloads that arrived before any mentra.on subscriber was
  // registered for the channel. The background side fires
  // session.ui.onOpen handlers as soon as the WebView posts {type:'ready'},
  // and on a fast bridge the resulting ui.send round-trips back before
  // React useEffects have had a chance to attach listeners. Without
  // buffering, the very first snapshot (the one a controller pushes from
  // its ui.onOpen handler to hydrate the fresh UI) is silently dropped.
  //
  // Drain policy: the queue for a channel is flushed into the FIRST
  // mentra.on(channel, ...) subscriber, then discarded. Subsequent
  // sends with no listener fall back to the old drop-on-floor behaviour
  // — we don't want a re-subscribe to replay stale state.
  //
  // Cap: 32 entries per channel, oldest dropped on overflow. Bounds the
  // memory cost when a controller pushes to a channel that no UI page
  // ever subscribes to.
  var pendingByChannel = Object.create(null);
  var PENDING_CAP_PER_CHANNEL = 32;

  function postEnvelope(envelope) {
    var rnPost = getRnPost();
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

  // NOTE: console.* tap lives in miniappGlobals.ts (injected alongside
  // this shim for every UI WebView, two-layer or single-bundle). That
  // shim posts {payload:{type:"dev_log", ...}} envelopes which
  // LocalMiniappRuntime forwards to the dev sidecar tagged source:"ui".
  // We don't re-wrap here to avoid double-delivery.

  function on(channel, cb) {
    if (typeof cb !== 'function') return function () {};
    var list = channelHandlers[channel];
    var firstSubscriber = !list || list.length === 0;
    if (!list) { list = []; channelHandlers[channel] = list; }
    list.push(cb);
    // Drain any payloads buffered before this channel had a listener.
    // Only fired on the first subscriber for the channel — a later
    // re-subscribe (after an unsubscribe) does NOT replay history.
    if (firstSubscriber) {
      var pending = pendingByChannel[channel];
      if (pending) {
        delete pendingByChannel[channel];
        for (var i = 0; i < pending.length; i++) {
          try { cb(pending[i]); } catch (e) {}
        }
      }
    }
    return function () {
      var idx = list.indexOf(cb);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  // ── RPC ─────────────────────────────────────────────────────────────
  // Outbound RPC: every mentra.request() generates a request id, sends a
  // 'msg' envelope tagged with requestId, and stashes a one-shot resolver
  // keyed on the id. The background-side reply is a recv('msg') with the
  // same channel + requestId; we route it directly to the resolver.
  //
  // Cancellation: caller's AbortSignal triggers a 'cancel' envelope to
  // background and rejects the local promise with a DOM-standard
  // AbortError. The background side's UI_CANCEL handler aborts the
  // handler's ctx.signal and drops the reply.
  var rpcCounter = 0;
  var rpcInflight = Object.create(null);

  function makeRequestId() {
    rpcCounter += 1;
    return 'r' + rpcCounter + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function MentraRpcError(message, code, stage, transport) {
    var e = new Error(message);
    e.name = 'MentraRpcError';
    if (code) {
      try { e.cause = {code: code}; } catch (_) { /* old runtimes */ }
      e.code = code;
    }
    // Diagnostic fields ride as own props so a miniapp can show exactly which
    // pipeline stage and transport failed, not just a message string.
    if (stage) e.stage = stage;
    if (transport) e.transport = transport;
    return e;
  }

  function MentraRpcTimeoutError(message) {
    var e = new Error(message || 'RPC timed out');
    e.name = 'MentraRpcTimeoutError';
    return e;
  }

  function MentraAbortError() {
    var e;
    try { e = new DOMException('aborted', 'AbortError'); } catch (_) {
      e = new Error('aborted');
      e.name = 'AbortError';
    }
    return e;
  }

  function request(channel, payload, options) {
    var opts = options || {};
    var signal = opts.signal;
    var timeoutMs = typeof opts.timeout === 'number' ? opts.timeout : null;
    var id = makeRequestId();

    return new Promise(function (resolve, reject) {
      var done = false;
      var timeoutHandle = null;
      var abortListener = null;

      function cleanup() {
        if (done) return;
        done = true;
        delete rpcInflight[id];
        if (timeoutHandle != null) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        if (signal && abortListener) {
          try { signal.removeEventListener('abort', abortListener); } catch (_) {}
        }
      }

      function settle(envelope) {
        if (done) return;
        cleanup();
        if (envelope && envelope.ok === true) {
          resolve(envelope.result);
        } else if (envelope && envelope.ok === false) {
          reject(MentraRpcError(envelope.error && envelope.error.message || 'RPC failed', envelope.error && envelope.error.code, envelope.error && envelope.error.stage, envelope.error && envelope.error.transport));
        } else {
          reject(MentraRpcError('malformed RPC reply'));
        }
      }

      rpcInflight[id] = settle;

      if (signal) {
        if (signal.aborted) {
          cleanup();
          reject(MentraAbortError());
          return;
        }
        abortListener = function () {
          if (done) return;
          cleanup();
          postEnvelope({type: 'cancel', requestId: id});
          reject(MentraAbortError());
        };
        try { signal.addEventListener('abort', abortListener); } catch (_) {}
      }

      if (timeoutMs != null) {
        timeoutHandle = setTimeout(function () {
          if (done) return;
          cleanup();
          postEnvelope({type: 'cancel', requestId: id});
          reject(MentraRpcTimeoutError());
        }, timeoutMs);
      }

      var envelope = {type: 'msg', seq: outboundSeq++, channel: String(channel), payload: payload, requestId: id};
      if (!ready) {
        outboundQueue.push(envelope);
        return;
      }
      postEnvelope(envelope);
    });
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
    if (!list || list.length === 0) {
      // No subscriber yet — stash for the first mentra.on(channel, ...).
      // Bounded FIFO: drop the oldest when capped so a stuck channel
      // can't grow unbounded.
      var q = pendingByChannel[channel];
      if (!q) { q = []; pendingByChannel[channel] = q; }
      q.push(payload);
      if (q.length > PENDING_CAP_PER_CHANNEL) q.shift();
      return;
    }
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) {}
    }
  }

  function recv(envelope) {
    if (!envelope || typeof envelope !== 'object') return;
    var type = envelope.type;
    if (type === 'msg' && typeof envelope.channel === 'string') {
      // RPC frames carry a requestId; broadcast frames don't. Treat them
      // as disjoint — never fall through from RPC to broadcast. An orphan
      // RPC reply (caller already aborted/timed out) is silently dropped.
      if (typeof envelope.requestId === 'string') {
        var settle = rpcInflight[envelope.requestId];
        if (settle) settle(envelope.payload);
        return;
      }
      fireChannel(envelope.channel, envelope.payload);
      return;
    }
    if (type === 'open') {
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
    if (type === 'cancel' && typeof envelope.requestId === 'string') {
      // Background-side cancel (reserved; currently unused). If we had a
      // future bidirectional RPC this would abort an in-flight UI handler.
      return;
    }
    if (type === 'ack') {
      return;
    }
  }

  window.mentra = {
    send: send,
    on: on,
    request: request,
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
