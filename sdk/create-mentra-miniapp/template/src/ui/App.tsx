import {useEffect, useState} from "react"
import {MiniappHeader, useHistoryState, useSafeArea} from "@mentra/miniapp/ui"

type Screen = "home" | "about"

export function App() {
  // The WebView runs edge to edge, under the status bar, the home indicator,
  // and the host's capsule menu. Pad the root by the safe-area insets and let
  // <MiniappHeader> line each page's header up beside the capsule.
  const {insets} = useSafeArea()

  // useHistoryState instead of useState: every screen change is a history
  // entry, so the phone's back gesture returns to the previous screen before
  // it minimizes the miniapp.
  const [screen, setScreen] = useHistoryState<Screen>("screen", "home")

  return (
    <div
      className="app"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      {screen === "home" ? (
        <>
          <MiniappHeader title="My Miniapp" />
          <Home onOpenAbout={() => setScreen("about")} />
        </>
      ) : (
        <>
          <MiniappHeader title="About" onBack={() => history.back()} />
          <About />
        </>
      )}
    </div>
  )
}

function Home({onOpenAbout}: {onOpenAbout: () => void}) {
  const [roundtripMs, setRoundtripMs] = useState<number | null>(null)

  useEffect(() => {
    const unsub = mentra.on("pong", ({roundtripMs}) => {
      setRoundtripMs(roundtripMs)
    })
    return unsub
  }, [])

  const ping = () => {
    mentra.send("ping", {at: Date.now()})
  }

  return (
    <main className="content">
      <p>Round-trip to background: {roundtripMs == null ? "—" : `${roundtripMs} ms`}</p>
      <button type="button" onClick={ping}>
        Ping background
      </button>
      <button type="button" className="secondary" onClick={onOpenAbout}>
        About
      </button>
    </main>
  )
}

function About() {
  return (
    <main className="content">
      <p>{`{{packageName}}`}</p>
      <p>Swipe back or tap the chevron to return.</p>
    </main>
  )
}
