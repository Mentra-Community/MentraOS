// eslint-disable-next-line import/no-unresolved -- resolved after the template installs dependencies
import {MentraProvider, useConnected, useSession} from "@mentra/miniapp/react"

function Miniapp() {
  const session = useSession()
  const connected = useConnected()

  return (
    <div style={{padding: 20, fontFamily: "system-ui, sans-serif"}}>
      <h1>{{appName}}</h1>
      <p>{connected ? "Connected to MentraOS" : "Connecting to MentraOS..."}</p>
      <button
        onClick={() => {
          console.log("Button tapped")
          session.display.showTextWall("Hello from {{appName}}!")
        }}>
        Show on glasses
      </button>
    </div>
  )
}

export default function App() {
  return (
    <MentraProvider>
      <Miniapp />
    </MentraProvider>
  )
}
