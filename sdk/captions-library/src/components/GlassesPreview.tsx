import {useEffect, useState} from "react"
import {getPreview, subscribe} from "../glasses-controller"
import {CHARS_PER_LINE} from "../types"

/**
 * Anti-pattern #2 (in component form): each component subscribes
 * individually via useEffect. Three components like this one mounted
 * means three subscriptions to the same listeners set, three React
 * state setters per transcription chunk.
 *
 * Anti-pattern #3 (under "WebView always alive"): module-scope state
 * in glasses-controller.ts persists for hours. If the dev reads
 * `currentPreview` reference equality wrong, missed updates compound.
 */
export function GlassesPreview() {
  const [lines, setLines] = useState(getPreview())
  useEffect(() => subscribe(() => setLines(getPreview())), [])

  return (
    <div className="glasses-preview" style={previewStyle}>
      {lines.length === 0 ? (
        <span style={placeholderStyle}>Waiting for speech...</span>
      ) : (
        lines.map((line, i) => <div key={i}>{line || " "}</div>)
      )}
    </div>
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
