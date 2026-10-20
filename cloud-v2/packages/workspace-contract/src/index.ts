// Browser-safe entry point: types, the capability map, deletion holds in words and the license types, with no
// Node built-ins.
// Servers import the signature helpers and the Core client from "@mentra/workspace-contract/server".
// The Fleet UI contract names DOM types, so it lives at "@mentra/workspace-contract/fleet-ui".
export * from "./capabilities"
export * from "./deletion-holds"
export * from "./licenses"
export * from "./types"
