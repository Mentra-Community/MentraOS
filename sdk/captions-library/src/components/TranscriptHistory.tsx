import {useEffect, useState} from "react"
import {getHistory, getInterim, subscribe} from "../glasses-controller"
import {CHARS_PER_LINE} from "../types"

/**
 * Full transcript: every finalized utterance plus the current interim
 * (rendered distinctly: italic + reduced opacity) at the bottom.
 *
 * Anti-pattern #2 (continued): yet another component subscribing
 * independently. Add a fourth (status indicator, badge, etc) and the
 * fan-out keeps scaling linearly. Each transcription chunk fires every
 * subscriber's React state setter regardless of whether that setter
 * cares about the change.
 */
export function TranscriptHistory() {
  const [history, setHistory] = useState(getHistory())
  const [interim, setInterim] = useState(getInterim())
  useEffect(
    () =>
      subscribe(() => {
        setHistory(getHistory())
        setInterim(getInterim())
      }),
    [],
  )

  if (history.length === 0 && !interim) {
    return <p style={emptyStyle}>No transcripts yet.</p>
  }

  return (
    <ol style={historyStyle}>
      {history.map((u) => (
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

const emptyStyle: React.CSSProperties = {
  opacity: 0.6,
  width: `${CHARS_PER_LINE}ch`,
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
