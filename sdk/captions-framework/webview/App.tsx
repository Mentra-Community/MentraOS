/**
 * webview/App.tsx
 *
 * React UI for the phone. Pure presentation layer.
 *
 * `useMentra()` returns:
 *   - mentra.state.*   reactive snapshots of state defined in client/
 *   - mentra.client.*  typed proxies for functions exported from client/
 *
 * The webview cannot subscribe to hardware events, cannot mutate state
 * directly, cannot import `session`. The runtime is not in scope here,
 * by construction.
 */

import {useMentra} from "@mentra/miniapp/framework/react"
import {CHARS_PER_LINE} from "../shared/types"

export default function App() {
  return (
    <main>
      <h1>Captions</h1>
      <GlassesPreview />
      <SettingsPanel />
    </main>
  )
}

/**
 * Renders the same formatted lines that are being shown on the glasses
 * HUD. `mentra.state.preview` is produced by client/index.ts using the
 * current `displayLines` value, so this preview and the HUD always agree.
 */
function GlassesPreview() {
  const mentra = useMentra()
  const lines = mentra.state.preview

  return (
    <div className="glasses-preview" style={previewStyle}>
      {lines.length === 0 ? (
        <span style={placeholderStyle}>Waiting for speech...</span>
      ) : (
        lines.map((line, i) => <div key={i}>{line || " "}</div>)
      )}
    </div>
  )
}

function SettingsPanel() {
  const mentra = useMentra()
  const lines = mentra.state.displayLines

  return (
    <section>
      <label htmlFor="lines">Lines on HUD: {lines}</label>
      <input
        id="lines"
        type="range"
        min={2}
        max={5}
        step={1}
        value={lines}
        onChange={(e) => mentra.client.setDisplayLines(Number(e.target.value))}
      />
    </section>
  )
}

const previewStyle: React.CSSProperties = {
  background: "#000",
  color: "#0f0",
  fontFamily: "monospace",
  padding: 12,
  width: `${CHARS_PER_LINE}ch`,
  whiteSpace: "pre",
  borderRadius: 4,
}

const placeholderStyle: React.CSSProperties = {
  opacity: 0.5,
}
