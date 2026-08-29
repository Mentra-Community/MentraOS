import type {MiniappCapsuleMenuRect} from "../globals"

export function getCapsuleHeaderPaddingRight(
  capsuleMenu: MiniappCapsuleMenuRect,
  viewportWidth: number,
  safeAreaRight: number,
  rightGap: number,
): number {
  const capsuleOffsetFromContentRight = viewportWidth - capsuleMenu.left - safeAreaRight
  return Math.max(rightGap, capsuleOffsetFromContentRight + rightGap)
}
