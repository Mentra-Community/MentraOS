import {useState, useEffect} from "react"
import "./index.css"

interface PhotoData {
  photoCount: number
  filename: string
  size: number
  mimeType: string
  timestamp: string
  dataUrl: string
}

export function App() {
  const [photo, setPhoto] = useState<PhotoData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const fetchLatestPhoto = async () => {
    try {
      const response = await fetch("/api/latest-photo")

      if (response.status === 404) {
        setError("No photo available yet")
        setPhoto(null)
        return
      }

      if (response.status === 401) {
        setError("Not authenticated - please connect glasses first")
        setPhoto(null)
        return
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = (await response.json()) as PhotoData
      setPhoto(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch photo")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLatestPhoto()

    if (autoRefresh) {
      const interval = setInterval(fetchLatestPhoto, 2000)
      return () => clearInterval(interval)
    }
  }, [autoRefresh])

  return (
    <div className="w-screen h-screen bg-zinc-900 flex flex-col overflow-hidden font-sans text-white">
      {/* Header */}
      <header className="bg-zinc-800 px-4 py-3 flex items-center justify-between border-b border-zinc-700">
        <h1 className="text-xl font-semibold">📸 Photo Test</h1>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAutoRefresh(e.target.checked)}
              className="w-4 h-4"
            />
            Auto-refresh
          </label>
          <button onClick={fetchLatestPhoto} className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-sm">
            Refresh
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center p-4 overflow-auto">
        {loading ? (
          <div className="text-zinc-400 text-lg">Loading...</div>
        ) : error ? (
          <div className="text-center">
            <div className="text-red-400 text-lg mb-4">{error}</div>
            <button onClick={fetchLatestPhoto} className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded">
              Try Again
            </button>
          </div>
        ) : photo ? (
          <div className="flex flex-col items-center gap-4 max-w-full">
            <img
              src={photo.dataUrl}
              alt={`Photo #${photo.photoCount}`}
              className="max-w-full max-h-[60vh] rounded-lg shadow-xl object-contain"
            />
            <div className="bg-zinc-800 rounded-lg p-4 text-sm space-y-1">
              <div className="text-xl font-bold text-center mb-2">Photo #{photo.photoCount}</div>
              <div className="text-zinc-400">
                <span className="text-zinc-500">Filename:</span> {photo.filename}
              </div>
              <div className="text-zinc-400">
                <span className="text-zinc-500">Size:</span> {(photo.size / 1024).toFixed(1)} KB
              </div>
              <div className="text-zinc-400">
                <span className="text-zinc-500">Type:</span> {photo.mimeType}
              </div>
              <div className="text-zinc-400">
                <span className="text-zinc-500">Time:</span> {new Date(photo.timestamp).toLocaleTimeString()}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-zinc-400">No photo data</div>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-zinc-800 px-4 py-2 text-center text-zinc-500 text-sm border-t border-zinc-700">
        Photos are captured every 5 seconds
      </footer>
    </div>
  )
}

export default App
