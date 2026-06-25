import {useEffect, useMemo, useRef, useState} from "react"
import {useNavigate} from "react-router-dom"
import {Camera, Check, Heart, Loader2, Play, Plus, RefreshCw, Settings, Share2, Trash2} from "lucide-react"

import {Shell} from "../components/Shell"
import {Thumb} from "../components/Thumb"
import {cn} from "../lib/cn"
import {formatDuration, formatUsage, groupByDay} from "../lib/format"
import {useGallery} from "../store/galleryStore"
import type {GalleryFilter, PhotoItem} from "../../shared/types"

const isVideo = (p: PhotoItem) => Boolean(p.mimeType?.startsWith("video/")) || (p.durationMs ?? 0) > 0

export default function GridScreen() {
  const navigate = useNavigate()
  const {snapshot, status, capture, deletePhotos, favorite, share} = useGallery()

  const photos = snapshot?.photos ?? []
  const usage = snapshot?.usage?.bytes ?? 0
  const loaded = snapshot != null
  const syncing = snapshot?.capturing ?? false

  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<GalleryFilter>("all")

  const visible =
    filter === "photos" ? photos.filter((p) => !isVideo(p)) : filter === "videos" ? photos.filter(isVideo) : photos
  const groups = useMemo(() => groupByDay(visible), [visible])

  // Scroll-aware edge fade: photos dissolve into the page as they scroll under
  // the header and beneath the Sync Gallery pill. Top fade only once scrolled.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<{top: boolean; bottom: boolean}>({top: false, bottom: false})
  const updateFade = () => {
    const el = scrollRef.current
    if (!el) return
    const top = el.scrollTop > 4
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4
    setFade((f) => (f.top === top && f.bottom === bottom ? f : {top, bottom}))
  }
  useEffect(() => {
    updateFade()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, selecting])
  const maskTop = fade.top ? "transparent 0, #000 32px" : "#000 0, #000 0"
  const maskBottom = fade.bottom ? "#000 calc(100% - 104px), transparent 100%" : "#000 100%, #000 100%"
  const scrollMask = `linear-gradient(to bottom, ${maskTop}, ${maskBottom})`

  const exitSelect = () => {
    setSelecting(false)
    setSelected(new Set())
  }
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (loaded && photos.length === 0) {
    return <EmptyState syncing={syncing} onCapture={() => capture()} onSettings={() => navigate("/settings")} />
  }

  const selCount = selected.size

  return (
    <Shell tone="light">
      {/* Top bar — settings gear (host window-control capsule sits top-right) */}
      <div className="flex h-14 shrink-0 items-center px-4">
        {!selecting && (
          <button
            type="button"
            aria-label="Settings"
            onClick={() => navigate("/settings")}
            className="grid size-10 place-items-center rounded-full text-ink transition-colors hover:bg-surface">
            <Settings className="size-[22px]" strokeWidth={1.75} />
          </button>
        )}
      </div>

      {/* Headline + meta */}
      <div className="shrink-0 px-5">
        <div className="flex items-end justify-between">
          <h1 className="font-display text-[40px] font-[800] leading-[0.95] tracking-[-0.02em] text-ink">
            {selecting ? `${selCount} selected` : "Gallery"}
          </h1>
          {selecting && (
            <button
              type="button"
              aria-label="Cancel selection"
              onClick={exitSelect}
              className="mb-1 grid size-9 place-items-center rounded-full bg-surface text-ink transition-colors hover:bg-line">
              <Plus className="size-5 rotate-45" />
            </button>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <span className="font-mono text-[12px] uppercase tracking-[0.06em] text-muted">
            {selecting ? "Tap photos to select" : `${photos.length} Photos · ${formatUsage(usage)}`}
          </span>
          {!selecting && (
            <button
              type="button"
              onClick={() => setSelecting(true)}
              className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
              <Check className="size-4" strokeWidth={2.25} /> Select
            </button>
          )}
        </div>

        {!selecting && (
          <div className="mt-4 flex items-center gap-2">
            <FilterPill active={filter === "all"} onClick={() => setFilter("all")}>
              All
            </FilterPill>
            <FilterPill active={filter === "photos"} onClick={() => setFilter("photos")}>
              Photos
            </FilterPill>
            <FilterPill active={filter === "videos"} onClick={() => setFilter("videos")}>
              Videos
            </FilterPill>
          </div>
        )}
      </div>

      {/* Grid */}
      <div
        ref={scrollRef}
        onScroll={updateFade}
        className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-24"
        style={{maskImage: scrollMask, WebkitMaskImage: scrollMask}}>
        {groups.map((g) => (
          <section key={g.key} className="mb-6">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-display text-[20px] font-bold text-ink">{g.label}</h2>
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted">{g.items.length} Photos</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {g.items.map((item) => (
                <Tile
                  key={item.id}
                  item={item}
                  selecting={selecting}
                  selected={selected.has(item.id)}
                  justSaved={status?.savedId === item.id}
                  onOpen={() => navigate(`/photo/${photos.findIndex((p) => p.id === item.id)}`)}
                  onToggle={() => toggle(item.id)}
                  onLongPress={() => {
                    setSelecting(true)
                    setSelected(new Set([item.id]))
                  }}
                />
              ))}
            </div>
          </section>
        ))}
        {visible.length === 0 && photos.length > 0 && (
          <div className="flex flex-col items-center gap-1 pt-16 text-center">
            <span className="font-display text-[18px] font-bold text-ink">No {filter} yet</span>
            <span className="text-[13px] text-muted">
              {filter === "videos" ? "Record video on Mentra Live to see it here." : "Capture photos to see them here."}
            </span>
          </div>
        )}
      </div>

      {/* Sync action bar — solid, no gradient */}
      {!selecting && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-5 pt-3 pb-7">
          <button
            type="button"
            aria-label="Sync gallery"
            onClick={() => capture()}
            disabled={syncing}
            className="pointer-events-auto flex h-[54px] w-full items-center justify-center gap-2.5 rounded-full bg-ink text-white shadow-[0_6px_20px_rgba(11,14,20,0.18)] transition-transform active:scale-[0.99] disabled:opacity-80">
            {syncing ? <Loader2 className="size-5 animate-spin" /> : <RefreshCw className="size-5" strokeWidth={2} />}
            <span className="text-[16px] font-semibold">{syncing ? "Syncing…" : "Sync Gallery"}</span>
          </button>
        </div>
      )}

      {/* Selection dock */}
      {selecting && (
        <div className="absolute inset-x-0 bottom-0 z-30 flex items-center justify-around border-t border-line bg-ground px-2 py-3">
          <DockButton
            icon={<Share2 className="size-[22px]" strokeWidth={1.75} />}
            label="Share"
            disabled={selCount !== 1}
            onClick={() => {
              const id = [...selected][0]
              if (id) share(id)
            }}
          />
          <DockButton
            icon={<Heart className="size-[22px]" strokeWidth={1.75} />}
            label="Favorite"
            disabled={selCount === 0}
            onClick={() => {
              for (const id of selected) favorite(id, true)
              exitSelect()
            }}
          />
          <DockButton
            icon={<Trash2 className="size-[22px]" strokeWidth={1.75} />}
            label="Delete"
            tone="danger"
            disabled={selCount === 0}
            onClick={() => {
              deletePhotos([...selected])
              exitSelect()
            }}
          />
        </div>
      )}
    </Shell>
  )
}

// ─── Filter pill ────────────────────────────────────────────────────────────

function FilterPill({active, onClick, children}: {active?: boolean; onClick?: () => void; children: React.ReactNode}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-[17px] py-[9px] text-[13px] transition-colors",
        active ? "bg-ink font-semibold text-white" : "border border-line font-medium text-ink",
      )}>
      {children}
    </button>
  )
}

// ─── Tile ────────────────────────────────────────────────────────────────────

function Tile({
  item,
  selecting,
  selected,
  justSaved,
  onOpen,
  onToggle,
  onLongPress,
}: {
  item: PhotoItem
  selecting: boolean
  selected: boolean
  justSaved: boolean
  onOpen: () => void
  onToggle: () => void
  onLongPress: () => void
}) {
  const timer = useRef<number | null>(null)
  const longFired = useRef(false)
  const start = useRef<{x: number; y: number} | null>(null)
  const clear = () => {
    if (timer.current) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }
  const video = isVideo(item)

  return (
    <button
      type="button"
      className={cn("relative aspect-square", justSaved && "animate-tile-pop")}
      onPointerDown={(e) => {
        longFired.current = false
        start.current = {x: e.clientX, y: e.clientY}
        timer.current = window.setTimeout(() => {
          longFired.current = true
          onLongPress()
        }, 420)
      }}
      onPointerMove={(e) => {
        if (timer.current && start.current) {
          const moved = Math.abs(e.clientX - start.current.x) + Math.abs(e.clientY - start.current.y)
          if (moved > 10) clear()
        }
      }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (longFired.current) {
          longFired.current = false
          return
        }
        if (selecting) onToggle()
        else onOpen()
      }}>
      <Thumb item={item} rounded="rounded-[6px]" className="size-full" />

      {video && (
        <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-[3px]">
          <Play className="size-2.5 fill-white text-white" />
          <span className="font-mono text-[10px] font-semibold leading-none text-white">
            {formatDuration(item.durationMs ?? 0)}
          </span>
        </span>
      )}

      {selecting && selected && (
        <>
          <span className="pointer-events-none absolute inset-0 rounded-[6px] [box-shadow:inset_0_0_0_3px_var(--color-ink)]" />
          <span className="absolute right-1.5 top-1.5 grid size-[22px] place-items-center rounded-full border-2 border-white bg-ink">
            <Check className="size-3 text-white" strokeWidth={3.4} />
          </span>
        </>
      )}
    </button>
  )
}

// ─── Selection dock button ──────────────────────────────────────────────────

function DockButton({
  icon,
  label,
  onClick,
  disabled,
  tone = "default",
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  tone?: "default" | "danger"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-1 flex-col items-center gap-1 py-1 transition-opacity active:opacity-60 disabled:opacity-30",
        tone === "danger" ? "text-red-600" : "text-ink",
      )}>
      {icon}
      <span className="text-[11px] font-medium">{label}</span>
    </button>
  )
}

// ─── Empty state ────────────────────────────────────────────────────────────

function EmptyState({
  syncing,
  onCapture,
  onSettings,
}: {
  syncing: boolean
  onCapture: () => void
  onSettings: () => void
}) {
  return (
    <Shell tone="light">
      <div className="flex h-14 shrink-0 items-center px-4">
        <button
          type="button"
          aria-label="Settings"
          onClick={onSettings}
          className="grid size-10 place-items-center rounded-full text-ink transition-colors hover:bg-surface">
          <Settings className="size-[22px]" strokeWidth={1.75} />
        </button>
      </div>
      <div className="shrink-0 px-5">
        <h1 className="font-display text-[40px] font-[800] leading-[0.95] tracking-[-0.02em] text-ink">Gallery</h1>
        <span className="mt-3 block font-mono text-[12px] uppercase tracking-[0.06em] text-muted">0 Photos · 0 GB</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-10 text-center">
        <div className="relative grid size-[112px] place-items-center rounded-[26px] border-2 border-dashed border-line bg-surface">
          <Camera className="size-10 text-muted" strokeWidth={1.5} />
          <span className="absolute -bottom-2 -right-2 grid size-9 place-items-center rounded-full bg-cobalt text-white">
            <Plus className="size-4" strokeWidth={2.5} />
          </span>
        </div>

        <h2 className="mt-8 font-display text-[24px] font-bold text-ink">No captures yet</h2>
        <p className="mt-2 max-w-[280px] text-[15px] leading-[1.5] text-muted">
          Photos you take on Mentra Live will show up here, organized by day.
        </p>

        <div className="mt-8 flex flex-col items-center gap-4">
          <button
            type="button"
            onClick={onCapture}
            disabled={syncing}
            className="flex items-center gap-2.5 rounded-full bg-ink px-7 py-4 text-white transition-transform active:scale-95 disabled:opacity-70">
            {syncing ? <Loader2 className="size-5 animate-spin" /> : <RefreshCw className="size-5" strokeWidth={2} />}
            <span className="text-[16px] font-semibold">{syncing ? "Syncing…" : "Sync Gallery"}</span>
          </button>
          <button
            type="button"
            onClick={onCapture}
            disabled={syncing}
            className="flex items-center gap-2.5 rounded-full border-[1.5px] border-ink px-6 py-3 text-ink transition-transform active:scale-95 disabled:opacity-50">
            <Camera className="size-[18px]" strokeWidth={1.8} />
            <span className="text-[15px] font-semibold">Capture a photo</span>
          </button>
        </div>
      </div>
    </Shell>
  )
}
