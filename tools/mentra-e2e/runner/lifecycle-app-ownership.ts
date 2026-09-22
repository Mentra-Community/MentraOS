import {acquireAppOwnership} from "../../../mobile/scripts/app-ownership.mjs"
import type {LifecycleOptions} from "./lifecycle"

/** The reservation is durable before dispatch, including abrupt process exit.
 * Only lifecycle completion may release it; recorder cleanup cannot override that verdict. */
export function lifecycleAppOwnership(
  folder: string,
  cleanup: () => Promise<void>,
): Pick<LifecycleOptions, "acquireLease" | "onLeaseRetained"> {
  return {
    acquireLease: async (owner) => {
      const release = await acquireAppOwnership(folder, {
        reservation: {
          runID: owner.selection.runID,
          runDirectory: owner.runDirectory,
          fixtureID: owner.selection.fixtureID,
        },
        recovering: owner.recovering,
      })
      return async () => {
        await cleanup()
        await release()
      }
    },
    onLeaseRetained: async () => cleanup(),
  }
}
