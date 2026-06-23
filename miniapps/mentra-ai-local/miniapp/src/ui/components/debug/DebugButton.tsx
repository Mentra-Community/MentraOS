/** Minimal button used inside the debug overlay (replaces the cloud ui Button). */
export function DebugButton({
  onClick,
  disabled,
  variant = "default",
  children,
}: {
  onClick: () => void
  disabled?: boolean
  variant?: "default" | "destructive"
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50 ${
        variant === "destructive"
          ? "bg-red-500/80 text-white active:bg-red-500"
          : "bg-white/10 text-white active:bg-white/20"
      }`}
    >
      {children}
    </button>
  )
}
