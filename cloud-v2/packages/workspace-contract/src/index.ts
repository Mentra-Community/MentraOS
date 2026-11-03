// Browser-safe entry point: types, the capability map, deletion holds in words, the license types and the admin
// portal's registry types, with no Node built-ins.
// Servers import the signature helpers and the Core client from "@mentra/workspace-contract/server".
// The Fleet UI and portal module UI contracts name DOM types, so they live at "@mentra/workspace-contract/fleet-ui"
// and "@mentra/workspace-contract/portal-module-ui".
export * from "./capabilities"
export * from "./deletion-holds"
export * from "./licenses"
export * from "./registry-admin"
export * from "./types"
