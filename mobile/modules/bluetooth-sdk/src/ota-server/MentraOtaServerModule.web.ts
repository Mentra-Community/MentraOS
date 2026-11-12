import {NativeModule, registerWebModule} from "expo"

import type {MentraOtaServerModuleEvents, OtaServerResult} from "./MentraOtaServer.types"

class MentraOtaServerModule extends NativeModule<MentraOtaServerModuleEvents> {
  async startOtaServer(): Promise<OtaServerResult> {
    throw new Error("The OTA server is only available in native apps.")
  }

  async stopOtaServer(): Promise<void> {}
}

export default registerWebModule(MentraOtaServerModule, "MentraOtaServer")
