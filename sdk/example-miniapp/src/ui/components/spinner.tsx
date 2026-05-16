import {cn} from "./button"

interface SpinnerProps {
  className?: string
  size?: "sm" | "default" | "lg"
}

const sizeClasses = {
  sm: "h-4 w-4",
  default: "h-5 w-5",
  lg: "h-6 w-6",
}

export function Spinner({className, size = "default"}: SpinnerProps) {
  return (
    <svg
      className={cn("animate-spin text-current", sizeClasses[size], className)}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
}
