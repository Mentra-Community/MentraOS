/**
 * Universal toast — black full-rounded pill with white text, auto-
 * dismissing. App-global so any page/component can fire one without
 * mounting its own toast UI.
 *
 * Usage:
 *   1. Wrap the app once: <ToastProvider><App /></ToastProvider>
 *   2. Anywhere below: const toast = useToast(); toast("Copied")
 */

import {createContext, useCallback, useContext, useRef, useState} from "react"
import type {ReactNode} from "react"
import {AnimatePresence, motion} from "motion/react"

type ToastContextValue = (message: string, durationMs?: number) => void

const ToastContext = createContext<ToastContextValue | null>(null)

const DEFAULT_DURATION_MS = 2000

export function ToastProvider({children}: {children: ReactNode}) {
  const [message, setMessage] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toast = useCallback<ToastContextValue>((msg, durationMs = DEFAULT_DURATION_MS) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setMessage(msg)
    timerRef.current = setTimeout(() => setMessage(null), durationMs)
  }, [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <AnimatePresence>
        {message ? (
          <motion.div
            key="toast"
            initial={{opacity: 0, y: 16}}
            animate={{opacity: 1, y: 0}}
            exit={{opacity: 0, y: 16}}
            transition={{duration: 0.18, ease: "easeOut"}}
            className="pointer-events-none fixed inset-x-0 bottom-10 z-[100] flex justify-center px-6">
            <div className="rounded-full bg-black dark:bg-zinc-100 px-4 py-2.5 text-white dark:text-zinc-900 text-[14px] font-medium [box-shadow:#00000033_0px_6px_20px] max-w-[90vw] text-center">
              {message}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </ToastContext.Provider>
  )
}

/**
 * Returns the `toast(message, durationMs?)` dispatcher. Throws if used
 * outside a ToastProvider so misuse fails loudly at mount, not silently.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error("useToast must be used inside a ToastProvider")
  return ctx
}
