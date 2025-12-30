interface HeaderProps {
  connected: boolean
  error: string | null
}

export function Header({connected, error}: HeaderProps) {
  return (
    <div className="w-full flex flex-col">
      {/* Top header bar */}
      <div
        className="w-full px-6 py-3 backdrop-blur-lg flex justify-between items-center"
        style={{backgroundColor: "#6DAEA6"}}>
        {/* Title */}
        <div className="flex justify-start items-center gap-2">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-white">
            <path d="M17 8l4 4-4 4" />
            <path d="M7 16l-4-4 4-4" />
            <line x1="3" y1="12" x2="21" y2="12" />
          </svg>
          <div className="text-center text-white text-lg font-semibold font-['Red_Hat_Display'] leading-7">
            Line Width Debug
          </div>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-2">
          <div
            className={`w-2.5 h-2.5 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}
            title={connected ? "Connected to glasses" : "Not connected"}
          />
          <span className="text-white/80 text-sm font-['Red_Hat_Display']">
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="w-full px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
          <span className="text-amber-800 text-sm font-medium">{error}</span>
        </div>
      )}
    </div>
  )
}
