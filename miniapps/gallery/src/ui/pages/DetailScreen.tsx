import {useEffect, useState} from "react"
import {useNavigate, useParams} from "react-router-dom"
import {ChevronLeft, Download, Heart, Share2, Trash2} from "lucide-react"

import {Shell} from "../components/Shell"
import {usePhotoSrc} from "../hooks/usePhotoSrc"
import {cn} from "../lib/cn"
import {formatBytes, formatLongDate, formatTime} from "../lib/format"
import {useGallery} from "../store/galleryStore"
import type {PhotoItem} from "../../shared/types"

export default function DetailScreen() {
  const navigate = useNavigate()
  const params = useParams()
  const index = Number(params.index ?? 0)
  const {snapshot, favorite, share, deletePhotos} = useGallery()
  const photos = snapshot?.photos ?? []

  const photo = photos[index]
  useEffect(() => {
    if (snapshot && !photo) navigate("/", {replace: true})
  }, [snapshot, photo, navigate])
  if (!photo) return <Shell tone="dark" />

  return (
    <Shell tone="dark">
      {/* Top bar */}
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate("/")}
          className="grid size-10 place-items-center rounded-full bg-white/8 text-white hover:bg-white/15">
          <ChevronLeft className="size-5" />
        </button>
        <span className="font-mono text-[13px] tracking-[0.04em] text-white/55">
          {index + 1} / {photos.length}
        </span>
        <button
          type="button"
          aria-label={photo.favorite ? "Unfavorite" : "Favorite"}
          onClick={() => favorite(photo.id, !photo.favorite)}
          className="grid size-10 place-items-center rounded-full bg-white/8 hover:bg-white/15">
          <Heart className={cn("size-5", photo.favorite ? "fill-cobalt text-cobalt" : "text-white")} />
        </button>
      </div>

      {/* Photo */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-2">
        <HeroImage photo={photo} />
      </div>

      {/* Date + time */}
      <div className="shrink-0 px-5 pt-3">
        <div className="flex items-end justify-between">
          <h1 className="font-display text-[28px] font-bold tracking-[-0.01em] text-white">
            {formatLongDate(photo.createdAt)}
          </h1>
          <span className="font-mono text-[12px] tracking-[0.04em] text-white/55">{formatTime(photo.createdAt)}</span>
        </div>
        <div className="my-4 h-px bg-white/10" />
        <ExifRow photo={photo} />
      </div>

      {/* Filmstrip */}
      <div className="shrink-0 overflow-x-auto px-5 pt-4">
        <div className="flex gap-2">
          {photos.map((p, i) => (
            <FilmstripThumb key={p.id} item={p} active={i === index} onClick={() => navigate(`/photo/${i}`)} />
          ))}
        </div>
      </div>

      {/* Dock */}
      <div className="flex shrink-0 items-center justify-around px-2 pt-4 pb-5">
        <DockButton icon={<Share2 className="size-[22px]" strokeWidth={1.75} />} label="Share" onClick={() => share(photo.id)} />
        <DockButton icon={<Download className="size-[22px]" strokeWidth={1.75} />} label="Save" onClick={() => share(photo.id)} />
        <DockButton
          icon={<Trash2 className="size-[22px]" strokeWidth={1.75} />}
          label="Delete"
          tone="danger"
          onClick={() => {
            deletePhotos([photo.id])
            navigate("/", {replace: true})
          }}
        />
      </div>
    </Shell>
  )
}

function HeroImage({photo}: {photo: PhotoItem}) {
  const src = usePhotoSrc(photo)
  if (!src) return <div className="size-40 animate-pulse rounded-2xl bg-white/10" />
  return <img src={src} alt="" className="max-h-full max-w-full rounded-[20px] object-contain" />
}

function ExifRow({photo}: {photo: PhotoItem}) {
  const src = usePhotoSrc(photo)
  const [dims, setDims] = useState<string>("—")
  useEffect(() => {
    if (!src) return
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (alive && img.naturalWidth) setDims(`${img.naturalWidth}×${img.naturalHeight}`)
    }
    img.src = src
    return () => {
      alive = false
    }
  }, [src])

  return (
    <div className="grid grid-cols-4 gap-2">
      <Stat label="Res" value={dims} />
      <Stat label="Size" value={formatBytes(photo.bytes)} />
      <Stat label="Lens" value="ƒ/2.2" />
      <Stat label="Device" value="Live" />
    </div>
  )
}

function Stat({label, value}: {label: string; value: string}) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/40">{label}</div>
      <div className="mt-1 truncate font-mono text-[13px] text-white">{value}</div>
    </div>
  )
}

function FilmstripThumb({item, active, onClick}: {item: PhotoItem; active: boolean; onClick: () => void}) {
  const src = usePhotoSrc(item)
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative size-[52px] shrink-0 overflow-hidden rounded-[10px] transition-all",
        active ? "ring-2 ring-cobalt ring-offset-2 ring-offset-night" : "opacity-60",
      )}>
      {src ? (
        <img src={src} alt="" className="size-full object-cover" />
      ) : (
        <div className="size-full animate-pulse bg-white/10" />
      )}
    </button>
  )
}

function DockButton({
  icon,
  label,
  onClick,
  tone = "default",
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  tone?: "default" | "danger"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 flex-col items-center gap-1 py-1 transition-opacity active:opacity-60",
        tone === "danger" ? "text-red-400" : "text-white",
      )}>
      {icon}
      <span className="text-[11px] font-medium">{label}</span>
    </button>
  )
}
