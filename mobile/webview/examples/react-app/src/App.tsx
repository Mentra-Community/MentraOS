import {useEffect, useState} from "react"
import {CoreModule, Events} from "@mentra/webview-sdk"
import type {MicState} from "@mentra/webview-sdk"

function App() {
  const [transcription, setTranscription] = useState<string>("Waiting for speech...")
  const [micState, setMicState] = useState<MicState>("off")
  const [isTranscribing, setIsTranscribing] = useState(false)

  useEffect(() => {
    // Auto-start transcription when component mounts
    startTranscription()
  }, [])

  const startTranscription = () => {
    if (isTranscribing) return

    setIsTranscribing(true)
    Events.requestTranscriptions({type: "online", fallback: true}, (text) => {
      console.log("Transcription:", text)
      setTranscription(text)
      // Also display on glasses
      CoreModule.displayText(text)
    })
  }

  const stopTranscription = () => {
    if (!isTranscribing) return

    setIsTranscribing(false)
    Events.stopTranscriptions()
    setTranscription("Waiting for speech...")
  }

  const handleDisplayText = (text: string) => {
    CoreModule.displayText(text)
  }

  const toggleMic = () => {
    const newState: MicState = micState === "on" ? "off" : "on"
    setMicState(newState)
    CoreModule.setMicState(newState)
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="bg-black text-white p-8 text-center">
        <h1 className="text-3xl font-bold mb-2">MentraOS React App</h1>
        <p className="text-gray-300">Local Mini App Example with WebView SDK</p>
      </header>

      <main className="flex-1 p-4 md:p-8 max-w-4xl w-full mx-auto">
        <section className="bg-white rounded-xl p-6 mb-6 shadow-md">
          <h2 className="text-xl font-semibold mb-4">Display Controls</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <button
              onClick={() => handleDisplayText("Hello from React!")}
              className="px-6 py-4 bg-black text-white font-semibold rounded-lg shadow-md hover:bg-gray-800 active:scale-95 transition-all">
              Say Hello
            </button>
            <button
              onClick={() => handleDisplayText("Welcome to MentraOS")}
              className="px-6 py-4 bg-black text-white font-semibold rounded-lg shadow-md hover:bg-gray-800 active:scale-95 transition-all">
              Say Welcome
            </button>
            <button
              onClick={() => handleDisplayText(`Time: ${new Date().toLocaleTimeString()}`)}
              className="px-6 py-4 bg-black text-white font-semibold rounded-lg shadow-md hover:bg-gray-800 active:scale-95 transition-all">
              Show Time
            </button>
          </div>
        </section>

        <section className="bg-white rounded-xl p-6 mb-6 shadow-md">
          <h2 className="text-xl font-semibold mb-4">Microphone Control</h2>
          <div className="grid grid-cols-1 gap-4">
            <button
              onClick={toggleMic}
              className={`px-6 py-4 font-semibold rounded-lg shadow-md active:scale-95 transition-all ${
                micState === "on" ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-black text-white hover:bg-gray-800"
              }`}>
              Mic: {micState.toUpperCase()}
            </button>
          </div>
        </section>

        <section className="bg-white rounded-xl p-6 shadow-md">
          <h2 className="text-xl font-semibold mb-4">Transcription</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <button
              onClick={startTranscription}
              disabled={isTranscribing}
              className={`px-6 py-4 font-semibold rounded-lg shadow-md transition-all ${
                isTranscribing
                  ? "bg-blue-600 text-white cursor-not-allowed"
                  : "bg-black text-white hover:bg-gray-800 active:scale-95"
              }`}>
              Start Transcription
            </button>
            <button
              onClick={stopTranscription}
              disabled={!isTranscribing}
              className="px-6 py-4 bg-black text-white font-semibold rounded-lg shadow-md hover:bg-gray-800 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-black disabled:active:scale-100">
              Stop Transcription
            </button>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-black">
            <div className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-2">Last Transcription</div>
            <div className="text-base text-gray-900">{transcription}</div>
          </div>
        </section>
      </main>

      <footer className="bg-gray-100 p-4 text-center text-gray-600 text-sm">
        <p>Built with @mentra/webview-sdk</p>
      </footer>
    </div>
  )
}

export default App
