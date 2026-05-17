import {Drawer} from "@/frontend/components/Drawer/Drawer"

type Props = {
  open: boolean
  /** Friendly name of the destination just reached (e.g. "Ferry Building"). */
  destinationName?: string | null
  /** Full address of the destination, shown as the secondary line. */
  destinationAddress?: string | null
  onDone: () => void
}

export function ArrivalDrawer({open, destinationName, destinationAddress, onDone}: Props) {
  // Prefer the address as the secondary line; fall back to the name if
  // we somehow don't have an address. If neither is available we just
  // omit the line rather than show a placeholder.
  const subline = destinationAddress?.trim() || destinationName?.trim() || null

  return (
    <Drawer
      open={open}
      onClose={onDone}
      dismissOnSwipeDown
      className="[font-synthesis:none] pointer-events-auto mx-auto max-w-md flex flex-col rounded-tl-[28px] rounded-tr-[28px] pb-8 gap-4 bg-[#FFFFFFB8] border-t border-t-solid border-t-[#FFFFFF80] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#0000001A_0px_-6px_24px] antialiased px-5">
      <div className="flex items-center gap-3 pt-1">
        <CheckBadge />
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <div className="tracking-tight text-[#000000F2] font-sans font-semibold text-[32px]/9.5 truncate">
            You've arrived!
          </div>
          {subline ? (
            <div className="text-[#00000099] font-sans text-base/5.5 truncate">
              {subline}
            </div>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={onDone}
        className="h-13 flex items-center justify-center rounded-full px-4 w-full min-h-13 bg-[#1A1A1A] [box-shadow:#00000033_0px_6px_18px] shrink-0">
        <div className="text-white font-sans font-semibold text-base/5">
          Done
        </div>
      </button>
    </Drawer>
  )
}

function CheckBadge() {
  return (
    <div className="flex items-center justify-center rounded-full bg-[#34C759] [box-shadow:#34C75933_0px_4px_14px] shrink-0 size-12">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
        <path d="M5 12.5L10 17.5L19 7.5" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}
