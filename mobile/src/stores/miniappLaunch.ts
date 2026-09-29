import {create} from "zustand"

type MiniappOpeningAnimation = "slide" | "expand"

/** Presentation only: runtime startup does not wait on this state. */
export const useMiniappPresentationStore = create<{
  revealedPackageName: string | null
  setRevealedPackageName: (packageName: string | null) => void
  closingPackageName: string | null
  setClosingPackageName: (packageName: string | null) => void
}>((set) => ({
  revealedPackageName: null,
  setRevealedPackageName: (revealedPackageName) => set({revealedPackageName}),
  closingPackageName: null,
  setClosingPackageName: (closingPackageName) => set({closingPackageName}),
}))

let pending: {packageName: string; animation: MiniappOpeningAnimation} | null = null

/** Set immediately before foregrounding; consumed once by the mounted overlay. */
export function setMiniappOpeningAnimation(packageName: string, animation: MiniappOpeningAnimation) {
  pending = {packageName, animation}
}

export function consumeMiniappOpeningAnimation(packageName: string): MiniappOpeningAnimation {
  const animation = pending?.packageName === packageName ? pending.animation : "slide"
  pending = null
  return animation
}
