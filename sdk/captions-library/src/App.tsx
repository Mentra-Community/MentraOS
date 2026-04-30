import {GlassesPreview} from "./components/GlassesPreview"
import {SettingsPanel} from "./components/SettingsPanel"
import {TranscriptHistory} from "./components/TranscriptHistory"

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

const pageStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 16,
}
