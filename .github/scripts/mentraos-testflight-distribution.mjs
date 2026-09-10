export function validateMentraosTestflightDistribution(plan, group, record) {
  const external = plan.native.testflight?.audience === "external"
  if (external && (plan.channel !== "beta" || group !== "Mentra Staging Public")) {
    throw new Error("Public MentraOS TestFlight is only supported for staging")
  }
  if (
    !record || record.group !== group || record.audience !== (external ? "external" : "internal") ||
    !["available", "submitted", "skipped"].includes(record.status) ||
    typeof record.buildId !== "string" || !record.buildId ||
    !/^https:\/\//.test(record.installUrl || "")
  ) throw new Error("Invalid MentraOS TestFlight distribution evidence")
  if (!external && record.status !== "available") throw new Error("Internal MentraOS TestFlight must be available")
  if (external && !/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/.test(record.installUrl)) {
    throw new Error("Public MentraOS TestFlight requires a public invitation URL")
  }
  if (external && record.status === "available" && record.reviewState !== "APPROVED") {
    throw new Error("Available public MentraOS TestFlight requires approved review evidence")
  }
  if (record.status === "skipped" && !record.skipReason) throw new Error("Skipped MentraOS TestFlight must identify its reason")
  return record
}
