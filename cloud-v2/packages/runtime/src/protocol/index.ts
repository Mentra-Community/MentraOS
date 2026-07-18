// Compatibility shim: the wire protocol moved to its own leaf package so
// phone-side consumers (@mentra/cloud-client, @mentra/engine) don't drag the
// server runtime's dependencies. Server code imports @mentra/cloud-protocol
// directly; this keeps the package's "./protocol" entry working.
export * from "@mentra/cloud-protocol"
