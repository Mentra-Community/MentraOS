import {AnimatePresence, motion} from "motion/react"
import {Drawer} from "@/frontend/components/Drawer/Drawer"

type Props = {
  open: boolean
  onDone: () => void
}

export function ArrivalDrawer({open, onDone}: Props) {
  return (
    <Drawer
      open={open}
      onClose={onDone}
      dismissOnSwipeDown
      className="[font-synthesis:none] pointer-events-auto mx-auto max-w-md flex flex-col rounded-tl-[28px] rounded-tr-[28px] pb-8 gap-4 bg-[#FFFFFFB8] border-t border-t-solid border-t-[#FFFFFF80] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#0000001A_0px_-6px_24px] antialiased px-5">
      <div className="flex flex-col py-1 gap-1.5">
        <div className="[letter-spacing:-0.025em] text-[#000000F2] font-sans font-semibold text-[32px]/9.5">
          You've arrived
        </div>
        <div className="text-[#00000099] font-sans text-base/5.5">
          Destination is on your right
        </div>
      </div>
      <button
        type="button"
        onClick={onDone}
        className="h-13 flex items-center justify-center rounded-2xl px-4 w-full min-h-13 bg-[#1A1A1A] [box-shadow:#00000033_0px_6px_18px] shrink-0">
        <div className="text-white font-sans font-semibold text-base/5">
          Done
        </div>
      </button>
    </Drawer>
  )
}
