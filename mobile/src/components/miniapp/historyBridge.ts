/** Report same-document history changes that Android WebView misses. */
export const miniappHistoryBridge = `
(function () {
  if (window.__mentraHistoryInstalled) return;
  window.__mentraHistoryInstalled = true;
  var key = "__mentraHistoryDepth";
  var push = history.pushState.bind(history);
  var replace = history.replaceState.bind(history);
  var depth = 0;
  function state(value, n) { return Object.assign({}, value, {[key]: n}); }
  function notify() {
    window.ReactNativeWebView.postMessage(JSON.stringify({type: "mentra_history", depth: depth}));
  }
  replace(state(history.state, 0), "");
  history.pushState = function(value, title, url) {
    push(state(value, depth + 1), title, url);
    depth += 1;
    notify();
  };
  history.replaceState = function(value, title, url) {
    replace(state(value, depth), title, url);
    notify();
  };
  window.addEventListener("popstate", function(event) {
    depth = event.state && event.state[key] || 0;
    notify();
  });
  notify();
})(); true;
`
