// Test/benchmark infrastructure. Used only by the (Super-Mode-gated)
// stress-test screen to mount synthetic WebViews of a controlled size.

/**
 * Generates an HTML doc for a "dummy" miniapp WebView. Allocates `mb` MB of
 * JS heap on load by holding onto a Uint8Array, plus a periodic timer that
 * touches the buffer every 5s so iOS doesn't claim the memory back as cold.
 *
 * The page also posts a `__STRESS_READY__` message back to the host as soon
 * as the allocation is complete, so the harness can know it's stable.
 */
export function buildDummyMiniappHtml(packageName: string, mb: number): string {
  const bytes = Math.max(1, Math.floor(mb)) * 1024 * 1024
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;background:#111;color:#9f9;font:14px monospace;padding:12px;">
<pre id="log">stress dummy ${packageName} (${mb} MB)\n</pre>
<script>
  (function () {
    var log = function (m) {
      var el = document.getElementById('log');
      if (el) el.textContent += m + '\\n';
      try { window.ReactNativeWebView && window.ReactNativeWebView.postMessage('STRESS-DUMMY: ' + m); } catch (e) {}
    };
    try {
      // Allocate and PIN — fill so the OS can't lazily back this with zero pages.
      var buf = new Uint8Array(${bytes});
      for (var i = 0; i < buf.length; i += 4096) buf[i] = (i >>> 16) & 0xff;
      window.__stressBuf = buf; // global root keeps GC at bay
      log('allocated ' + (buf.length / 1024 / 1024).toFixed(1) + ' MB');
      try { window.ReactNativeWebView && window.ReactNativeWebView.postMessage('STRESS-DUMMY: ready ${packageName}'); } catch (e) {}

      // Touch the buffer every 5s so iOS doesn't decide it's cold.
      setInterval(function () {
        var b = window.__stressBuf;
        if (!b) return;
        for (var j = 0; j < b.length; j += 65536) b[j] = (b[j] + 1) & 0xff;
        log('tick ' + new Date().toISOString());
      }, 5000);
    } catch (e) {
      log('alloc-failed: ' + (e && e.message));
    }
  })();
</script>
</body></html>`
}
