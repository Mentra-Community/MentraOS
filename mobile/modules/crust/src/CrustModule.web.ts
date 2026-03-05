import {registerWebModule, NativeModule} from "expo"

import {CrustModuleEvents} from "./Crust.types"

class CrustModule extends NativeModule<CrustModuleEvents> {
  PI = Math.PI
  async setValueAsync(value: string): Promise<void> {
    this.emit("onChange", {value})
  }
  hello() {
    return "Hello world! 👋"
  }
}

export default registerWebModule(CrustModule, "CrustModule")
