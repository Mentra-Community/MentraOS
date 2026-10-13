// Browser-safe entry point: types and the capability map only, with no Node built-ins.
// Servers import the signature helpers and the Core client from "@mentra/workspace-contract/server".
// The Fleet UI contract names DOM types, so it lives at "@mentra/workspace-contract/fleet-ui".
export * from "./capabilities"
export * from "./types"
