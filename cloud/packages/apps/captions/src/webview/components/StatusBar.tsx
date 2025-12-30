interface StatusBarProps {
  isListening: boolean
}

export function StatusBar({isListening}: StatusBarProps) {
  return (
    <div className="self-stretch pb-2 inline-flex justify-start items-center">
      {isListening && (
        <div className="px-2 py-1.5 bg-destructive rounded-2xl backdrop-blur-lg flex justify-center items-center gap-2.5">
          {/* Sound wave bars */}
          <div className="w-3 flex justify-between items-center gap-0.5">
            <div className="w-0.5 h-2 bg-red-600 rounded-full animate-pulse" />
            <div className="w-0.5 h-3.5 bg-red-600 rounded-full animate-pulse delay-75" />
            <div className="w-0.5 h-2 bg-red-600 rounded-full animate-pulse delay-150" />
            <div className="w-0.5 h-2.5 bg-red-600 rounded-full animate-pulse delay-200" />
            <div className="w-0.5 h-2 bg-red-600 rounded-full animate-pulse delay-300" />
          </div>
          <div className="text-primary-foreground text-xs font-semibold font-['Red_Hat_Display'] leading-4">
            LISTENING
          </div>
        </div>
      )}
    </div>
  )
}
