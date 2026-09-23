// Maestro runScript: ask the host-side hook (stream-preview-reload-hook.ts, started by
// stream-preview-run.sh) to reload the Mentra Call WebView document.
const response = http.post(RELOAD_HOOK_URL + "/reload", {body: ""})
if (response.status !== 200) {
  throw new Error("stream preview reload hook answered " + response.status + ": " + response.body)
}
output.reload = json(response.body)
