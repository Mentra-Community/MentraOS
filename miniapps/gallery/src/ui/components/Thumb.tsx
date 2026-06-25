import {usePhotoSrc} from "../hooks/usePhotoSrc"
import {cn} from "../lib/cn"
import type {PhotoItem} from "../../shared/types"

/** A photo thumbnail: resolves its source lazily and shows a soft skeleton. */
export function Thumb({
  item,
  className,
  rounded = "rounded-[14px]",
}: {
  item: PhotoItem
  className?: string
  rounded?: string
}) {
  const src = usePhotoSrc(item)
  return (
    <div className={cn("relative overflow-hidden bg-surface", rounded, className)}>
      {src ? (
        <img src={src} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-line" />
      )}
    </div>
  )
}
