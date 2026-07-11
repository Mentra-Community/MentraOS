interface EmptyStateProps {
  className?: string
}

export function EmptyState({className = ""}: EmptyStateProps) {
  return (
    <div className={`relative w-full h-full rounded-2xl overflow-hidden ${className}`}>
      {/* Background with gradient overlays */}
      <div className="absolute inset-0 bg-white dark:bg-zinc-900 rounded-2xl" />
      {/* Gradient blobs - positioned for better mobile view */}
      <div className="absolute w-64 h-64 -left-16 bottom-0 bg-emerald-200/80 dark:bg-emerald-900/40 rounded-full blur-3xl" />
      <div className="absolute w-64 h-64 -left-32 -top-20 bg-emerald-200/80 dark:bg-emerald-900/40 rounded-full blur-3xl" />
      <div className="absolute w-64 h-64 right-0 -top-10 bg-lime-100 dark:bg-lime-900/30 rounded-full blur-[32px]" />
      <div className="absolute w-64 h-64 right-8 top-1/2 bg-orange-50 dark:bg-orange-950/40 rounded-full blur-[32px]" />

      {/* Content */}
      <div className="relative flex items-center justify-center h-full px-6 py-8">
        <div className="flex flex-col justify-center items-start gap-4 max-w-sm">
          <h2 className="text-gray-900 dark:text-zinc-50 text-3xl sm:text-4xl font-normal font-['Red_Hat_Display'] leading-tight">
            Waiting for
            <br />
            speech.
          </h2>
          <p className="text-gray-600 dark:text-zinc-300 text-lg sm:text-xl font-normal font-['Red_Hat_Display'] leading-relaxed">
            Captions appear here as people speak. They&apos;re transient and won&apos;t be saved afterwards.
          </p>
        </div>
      </div>
    </div>
  )
}
