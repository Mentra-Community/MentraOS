import {useEffect, useRef, useState} from "react"
import type {ReactNode} from "react"

/**
 * Floating, draggable, collapsible dev panel.
 *
 * Collapsed → small circular button in a corner.
 * Expanded → header (drag handle + collapse button) above the children.
 *
 * Position and collapsed-state persist to localStorage under `storageKey`
 * so the panel stays where the user left it across reloads. Pass any dev
 * widgets as children — this component is purely a container.
 */

type Props = {
  /** Title shown in the panel header. */
  title?: string
  /** App version shown next to the title (e.g. "1.1.2"). Hidden when omitted. */
  version?: string
  /** Storage key for position + collapsed state. Use a unique key per
   *  page if you want independent panels. */
  storageKey?: string
  children: ReactNode
}

type Persisted = {x: number; y: number; collapsed: boolean}

function defaultState(): Persisted {
  return {
    x: typeof window !== "undefined" ? Math.max(0, (window.innerWidth - 352) / 2) : 16,
    y: typeof window !== "undefined" ? Math.max(0, (window.innerHeight - 400) / 2) : 16,
    collapsed: true,
  }
}


export function FloatingDevPanel({
  title = "Dev",
  version,
  storageKey = "FloatingDevPanel",
  children,
}: Props) {
  const [pos, setPos] = useState<{x: number; y: number}>(() => {
    const s = loadState(storageKey)
    return {x: s.x, y: s.y}
  })
  const [collapsed, setCollapsed] = useState<boolean>(() => loadState(storageKey).collapsed)
  const hasDragged = useRef(false)

  // Persist on change.
  useEffect(() => {
    saveState(storageKey, {x: pos.x, y: pos.y, collapsed})
  }, [storageKey, pos.x, pos.y, collapsed])

  // Soft-clamp into viewport on mount + resize. The panel is allowed
  // to be dragged mostly off-screen (so a dev who wants the map to be
  // fully visible can park it at the edge), but we always keep at
  // least KEEP_VISIBLE_PX of it reachable from each side — otherwise
  // it could be lost entirely with no way to drag back.
  // If the user hasn't dragged yet, re-center whenever collapsed
  // state changes.
  const rootRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const KEEP_VISIBLE_PX = 24
    function clamp() {
      const el = rootRef.current
      if (!el) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      if (!hasDragged.current) {
        setPos({
          x: Math.max(0, (window.innerWidth - w) / 2),
          y: Math.max(0, (window.innerHeight - h) / 2),
        })
      } else {
        const minX = -(w - KEEP_VISIBLE_PX)
        const maxX = window.innerWidth - KEEP_VISIBLE_PX
        const minY = -(h - KEEP_VISIBLE_PX)
        const maxY = window.innerHeight - KEEP_VISIBLE_PX
        setPos((p) => ({
          x: Math.max(minX, Math.min(maxX, p.x)),
          y: Math.max(minY, Math.min(maxY, p.y)),
        }))
      }
    }
    clamp()
    window.addEventListener("resize", clamp)
    return () => window.removeEventListener("resize", clamp)
  }, [collapsed])

  // Pointer-based drag (works for mouse + touch).
  const dragRef = useRef<{dx: number; dy: number; pointerId: number} | null>(null)
  function onPointerDown(e: React.PointerEvent<HTMLElement>) {
    const el = rootRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    dragRef.current = {
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      pointerId: e.pointerId,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current
    const el = rootRef.current
    if (!drag || !el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    // Allow dragging mostly off-screen, but keep KEEP_VISIBLE_PX
    // reachable from each edge so the panel can't be lost. Mirrors
    // the soft-clamp in the resize effect.
    const KEEP_VISIBLE_PX = 24
    const minX = -(w - KEEP_VISIBLE_PX)
    const maxX = window.innerWidth - KEEP_VISIBLE_PX
    const minY = -(h - KEEP_VISIBLE_PX)
    const maxY = window.innerHeight - KEEP_VISIBLE_PX
    const x = Math.max(minX, Math.min(maxX, e.clientX - drag.dx))
    const y = Math.max(minY, Math.min(maxY, e.clientY - drag.dy))
    setPos({x, y})
  }
  function onPointerUp(e: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (!drag) return
    ;(e.currentTarget as HTMLElement).releasePointerCapture(drag.pointerId)
    const moved = Math.abs(e.clientX - (pos.x + drag.dx)) > 4 || Math.abs(e.clientY - (pos.y + drag.dy)) > 4
    if (moved) hasDragged.current = true
    dragRef.current = null
  }

  if (collapsed) {
    return (
      <button
        ref={(el) => {
          rootRef.current = el
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={(e) => {
          // Suppress click if the pointer moved (drag, not tap).
          if (dragRef.current) return
          e.preventDefault()
          setCollapsed(false)
        }}
        style={{position: "fixed", left: pos.x, top: pos.y, touchAction: "none"}}
        className="z-9999 w-11 h-11 rounded-full bg-[#E11D48] text-white shadow-[#FFFFFF14_0px_1px_0px_inset,#00000073_0px_12px_30px] flex items-center justify-center select-none cursor-grab active:cursor-grabbing text-[11px] font-bold tracking-wider"
        aria-label={`Open ${title} panel`}>
        DBG
      </button>
    )
  }

  return (
    <div
      ref={(el) => {
        rootRef.current = el
      }}
      style={{position: "fixed", left: pos.x, top: pos.y}}
      className="[font-synthesis:none] antialiased z-9999 w-88 max-w-[calc(100vw-1rem)] max-h-[50vh] rounded-[22px] overflow-clip [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#00000073_0px_18px_50px] bg-[#FFFFFFA8] dark:bg-[#161619E6] border border-solid border-[#FFFFFF99] dark:border-[#FFFFFF1A] flex flex-col">
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{touchAction: "none"}}
        className="flex items-center h-11.5 pr-2.5 pl-3.5 gap-2.25 shrink-0 [box-shadow:#FFFFFF14_0px_1px_0px_inset] bg-[#1A1A1A] cursor-grab active:cursor-grabbing select-none">
        <div className="flex items-center justify-center shrink-0 text-white text-[11px] font-bold tracking-wider">
          DBG
        </div>
        <span className="grow tracking-[-0.01em] font-sans font-semibold text-white text-[15px]/5">{title}</span>
        {version ? (
          <span className="shrink-0 font-mono text-[11px] tracking-wide text-white/55 tabular-nums">v{version}</span>
        ) : null}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setCollapsed(true)}
          className="flex items-center justify-center w-7.5 h-7.5 rounded-[15px] shrink-0 bg-[#FFFFFF1F] hover:bg-[#FFFFFF2E] transition-colors"
          aria-label="Collapse">
          <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M5 12H19" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="overflow-y-auto p-3 grow">{children}</div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function loadState(key: string): Persisted {
  try {
    const raw = localStorage.getItem(key)
    const def = defaultState()
    if (!raw) return def
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      x: typeof parsed.x === "number" ? parsed.x : def.x,
      y: typeof parsed.y === "number" ? parsed.y : def.y,
      collapsed: typeof parsed.collapsed === "boolean" ? parsed.collapsed : def.collapsed,
    }
  } catch {
    return defaultState()
  }
}

function saveState(key: string, state: Persisted): void {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // localStorage unavailable / quota — ignore.
  }
}
