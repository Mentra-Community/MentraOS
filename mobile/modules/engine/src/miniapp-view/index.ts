/**
 * `@mentra/engine/miniapp-view` — a miniapp's screen. Mount `MiniappView` to
 * open a miniapp the engine has installed; unmount it to close the screen.
 */
export {
  MiniappView,
  type MiniappScreen,
  type MiniappViewHandle,
  type MiniappViewProps,
  type MiniappViewStatus,
} from "./MiniappView"
export type {MiniappColorScheme, MiniappSafeArea} from "../utils/miniappGlobals"
