import {forwardRef, useRef, useEffect} from "react"
import {X} from "lucide-react"

interface SearchBarProps {
  searchQuery: string
  onSearchChange: (value: string) => void
  onSearchSubmit: (e: React.FormEvent) => void
  onClear: () => void
  className?: string
  autoFocus?: boolean
}

const SearchBar = forwardRef<HTMLFormElement, SearchBarProps>(
  ({searchQuery, onSearchChange, onSearchSubmit, onClear, className = "", autoFocus = false}, ref) => {
    const inputRef = useRef<HTMLInputElement>(null)

    // Handle autoFocus with useEffect for more reliable focusing
    useEffect(() => {
      if (autoFocus && inputRef.current) {
        // Small delay to ensure the component is fully mounted and visible
        const timer = setTimeout(() => {
          inputRef.current?.focus()
        }, 50)
        return () => clearTimeout(timer)
      }
    }, [autoFocus])

    return (
      <form ref={ref} onSubmit={onSearchSubmit} className={`flex items-center space-x-3 ${className}`}>
        <div className="relative w-full">
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              style={{color: "var(--place-holder)"}}>
              <path
                d="M3 10C3 10.9193 3.18106 11.8295 3.53284 12.6788C3.88463 13.5281 4.40024 14.2997 5.05025 14.9497C5.70026 15.5998 6.47194 16.1154 7.32122 16.4672C8.1705 16.8189 9.08075 17 10 17C10.9193 17 11.8295 16.8189 12.6788 16.4672C13.5281 16.1154 14.2997 15.5998 14.9497 14.9497C15.5998 14.2997 16.1154 13.5281 16.4672 12.6788C16.8189 11.8295 17 10.9193 17 10C17 9.08075 16.8189 8.1705 16.4672 7.32122C16.1154 6.47194 15.5998 5.70026 14.9497 5.05025C14.2997 4.40024 13.5281 3.88463 12.6788 3.53284C11.8295 3.18106 10.9193 3 10 3C9.08075 3 8.1705 3.18106 7.32122 3.53284C6.47194 3.88463 5.70026 4.40024 5.05025 5.05025C4.40024 5.70026 3.88463 6.47194 3.53284 7.32122C3.18106 8.1705 3 9.08075 3 10Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M21 21L15 15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <input
            ref={inputRef}
            type="text"
            className=" h-[45px] theme-search-input text-[14px] w-full pl-10 pr-10 py-2.5 rounded-full focus:outline-none bg-[var(--primary-foreground)] text-[var(--text-primary)]"
            style={{
              color: "var(--text-primary)",
            }}
            placeholder="Search..."
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value)}
            autoFocus={autoFocus}
          />
          {searchQuery && (
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex items-center pr-3 hover:opacity-70 transition-opacity"
              onClick={onClear}>
              <X className="h-5 w-5 text-[var(--text-secondary)]" />
            </button>
          )}
        </div>
      </form>
    )
  },
)

SearchBar.displayName = "SearchBar"

export default SearchBar
