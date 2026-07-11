import {Languages} from "lucide-react"

interface EmptyStateProps {
  className?: string
}

export function EmptyState({className = ""}: EmptyStateProps) {
  return (
    <div className={`w-full h-full rounded-2xl bg-white dark:bg-zinc-900 flex items-center justify-center px-6 py-8 ${className}`}>
      <div className="flex flex-col justify-center items-start gap-4 max-w-sm">
        <div className="w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
          <Languages className="w-6 h-6 text-zinc-700 dark:text-zinc-200" />
        </div>
        <h2 className="text-gray-900 dark:text-zinc-50 text-3xl sm:text-4xl font-normal font-['Red_Hat_Display'] leading-tight">
          Waiting for speech.
        </h2>
        <p className="text-gray-600 dark:text-zinc-300 text-lg sm:text-xl font-normal font-['Red_Hat_Display'] leading-relaxed">
          Translations appear here as people speak. They&apos;re transient and won&apos;t be saved afterwards.
        </p>
      </div>
    </div>
  )
}
