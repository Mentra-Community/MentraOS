// Browser-safe entry point: types, the capability map and deletion holds in words, with no Node built-ins.
// Servers import the signature helpers and the Core client from "@mentra/workspace-contract/server".
// The Fleet UI contract names DOM types, so it lives at "@mentra/workspace-contract/fleet-ui".
export * from "./capabilities"
export * from "./deletion-holds"
export * from "./types"
