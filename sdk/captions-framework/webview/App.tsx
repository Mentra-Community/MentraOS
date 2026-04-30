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
 *
 * Layout: glasses HUD preview on top (a faithful preview of what is on
 * the glasses display right now), then the settings slider, then the
 * full transcript history scrolling below.
 */

import {useMentra} from "@mentra/miniapp/framework/react"
import type * as Client from "../client"
import type {AppState, UtteranceEntry} from "../shared/types"
import {CHARS_PER_LINE} from "../shared/types"

type Mentra = ReturnType<typeof useMentra<AppState, typeof Client>>

export default function App() {
  return (
    <main style={pageStyle}>
      <h1>Captions</h1>
      <GlassesPreview />
      <SettingsPanel />
      <TranscriptHistory />
    </main>
  )
}

/**
 * Faithful preview of the glasses HUD. Monochrome green, fixed width,
 * shows the same `mentra.state.preview` lines that the runtime is
 * sending to `session.display.showText(...)`.
 */
function GlassesPreview() {
  const mentra: Mentra = useMentra<AppState, typeof Client>()
  const lines = mentra.state.preview

  return (
    <div style={hudStyle}>
      {lines.length === 0 ? (
        <span style={hudPlaceholderStyle}>Waiting for speech...</span>
      ) : (
        lines.map((line, i) => <div key={i}>{line || " "}</div>)
      )}
    </div>
  )
}

function SettingsPanel() {
  const mentra: Mentra = useMentra<AppState, typeof Client>()
  const lines = mentra.state.displayLines

  return (
    <section style={settingsStyle}>
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

/**
 * Full transcript: every finalized utterance plus the current interim
 * (rendered distinctly: italic + reduced opacity) at the bottom.
 * Browser handles wrapping naturally; no character breaking here.
 */
function TranscriptHistory() {
  const mentra: Mentra = useMentra<AppState, typeof Client>()
  const history = mentra.state.history
  const interim = mentra.state.interim

  if (history.length === 0 && !interim) {
    return <p style={emptyStyle}>No transcripts yet.</p>
  }

  return (
    <ol style={historyStyle}>
      {history.map((u: UtteranceEntry) => (
        <li key={u.utteranceId} style={historyItemStyle}>
          {u.speakerId ? <span style={speakerStyle}>[{u.speakerId}]: </span> : null}
          {u.text}
        </li>
      ))}
      {interim ? (
        <li key={interim.utteranceId} style={interimItemStyle}>
          {interim.speakerId ? <span style={speakerStyle}>[{interim.speakerId}]: </span> : null}
          {interim.text}
        </li>
      ) : null}
    </ol>
  )
}

const pageStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 16,
}

const hudStyle: React.CSSProperties = {
  background: "#000",
  color: "#0f0",
  fontFamily: "monospace",
  padding: 12,
  width: `${CHARS_PER_LINE}ch`,
  whiteSpace: "pre",
  borderRadius: 4,
}

const hudPlaceholderStyle: React.CSSProperties = {
  opacity: 0.5,
}

const settingsStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  width: `${CHARS_PER_LINE}ch`,
}

const emptyStyle: React.CSSProperties = {
  opacity: 0.6,
}

const historyStyle: React.CSSProperties = {
  listStyle: "decimal inside",
  padding: 0,
  margin: 0,
  maxHeight: "60vh",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  lineHeight: 1.4,
}

const historyItemStyle: React.CSSProperties = {}

const interimItemStyle: React.CSSProperties = {
  opacity: 0.6,
  fontStyle: "italic",
}

const speakerStyle: React.CSSProperties = {
  fontWeight: 600,
  marginRight: 4,
}
