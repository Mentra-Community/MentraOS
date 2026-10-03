import {engine} from "@mentra/engine"

import mantle from "@/services/MantleManager"
import {createDeploymentAuthProvider} from "@/services/deployment/auth"
import {deploymentStore} from "@/services/deployment/store"
import mentraAuth from "@/utils/auth/authClient"

let recovery: Promise<void> | null = null

/** Share startup with the Activity, restore running miniapps, and reconnect without permission UI. */
export function recoverBackgroundRuntime(): Promise<void> {
  if (recovery) return recovery
  recovery = recover().finally(() => {
    recovery = null
  })
  return recovery
}

async function recover(): Promise<void> {
  if (!deploymentStore.isResolved() || deploymentStore.isSelectingWorkspace()) {
    console.warn("RECOVERY: deployment selection is unresolved; waiting for the Activity")
    return
  }
  const deployment = deploymentStore.getActive()
  if (deployment.kind === "workspace") {
    if (!(await createDeploymentAuthProvider(deployment).getSession())?.accessToken) {
      console.warn("RECOVERY: workspace sign-in required")
      return
    }
  } else {
    const session = await mentraAuth.getSession()
    if (session.is_error()) throw session.error
    if (!session.value?.token) {
      console.warn("RECOVERY: sign-in required")
      return
    }
  }

  await mantle.init({background: true})
  await mantle.waitForMiniapps()
  const readiness = engine.pairing.readiness()
  if (!readiness.connected && !readiness.nativeLinkBusy && (await engine.glasses.hasDefaultDevice())) {
    // Native connect checks existing permissions; never open permission dialogs
    // from a headless task. A live/reconnecting link is left to its native owner.
    await engine.glasses.connectDefault()
  }
  console.log("RECOVERY: JavaScript and miniapps restored; glasses connection requested if needed")
}
