import {NativeModule, requireNativeModule} from "expo"

import {CrustModuleEvents} from "./Crust.types"

declare class CrustModule extends NativeModule<CrustModuleEvents> {
  PI: number
  hello(): string
  setValueAsync(value: string): Promise<void>
}

// This call loads the native module object from the JSI.
export default requireNativeModule<CrustModule>("Crust")
