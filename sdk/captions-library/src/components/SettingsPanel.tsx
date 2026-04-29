import {useEffect, useState} from "react"
import {getSettings, subscribe, setDisplayLines} from "../glasses-controller"

export function SettingsPanel() {
  const [lines, setLines] = useState(getSettings().displayLines)
  useEffect(() => subscribe(() => setLines(getSettings().displayLines)), [])

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
        onChange={(e) => setDisplayLines(Number(e.target.value))}
      />
    </section>
  )
}
