// Reexport the native module. On web, it will be resolved to CoreModule.web.ts
// and on native platforms to CoreModule.ts
export {default} from "./CoreModule"
export * from "./Core.types"
