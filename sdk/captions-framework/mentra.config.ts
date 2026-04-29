/**
 * mentra.config.ts
 *
 * Single declarative config for the miniapp. The framework reads this
 * at build time. No imperative setup, no manual route registration.
 */

import {defineConfig} from "@mentra/miniapp/framework"

export default defineConfig({
  packageName: "com.mentra.captions-framework",
  name: "Captions",
  permissions: ["microphone", "display"],
})
