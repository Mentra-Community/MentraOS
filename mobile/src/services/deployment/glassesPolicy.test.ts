import {DeviceTypes} from "@mentra/engine"

import {deploymentStore} from "./store"
import {deploymentGlassesModelId, isGlassesModelAllowedByDeployment} from "./glassesPolicy"

jest.mock("@mentra/engine", () => ({
  DeviceTypes: {
    SIMULATED: "Simulated Glasses",
    LIVE: "Mentra Live",
    G1: "Even Realities G1",
    G2: "Even Realities G2",
    AR99: "AR99",
    MACH1: "Mentra Mach1",
    Z100: "Vuzix Z100",
    NEX: "Mentra Display",
    NIMO: "Nimo",
  },
}))

jest.mock("./store", () => ({
  deploymentStore: {getActive: jest.fn()},
}))

describe("workspace glasses policy", () => {
  it("uses an explicit model id for Simulated Glasses", () => {
    expect(deploymentGlassesModelId(DeviceTypes.SIMULATED)).toBe("simulated-glasses")
  })

  it("requires Simulated Glasses in a populated workspace allowlist", () => {
    ;(deploymentStore.getActive as jest.Mock).mockReturnValue({
      kind: "workspace",
      manifest: {glasses: {allowedModelsOverride: ["mentra-live"]}},
    })
    expect(isGlassesModelAllowedByDeployment(DeviceTypes.SIMULATED)).toBe(false)
    ;(deploymentStore.getActive as jest.Mock).mockReturnValue({
      kind: "workspace",
      manifest: {glasses: {allowedModelsOverride: ["mentra-live", "simulated-glasses"]}},
    })
    expect(isGlassesModelAllowedByDeployment(DeviceTypes.SIMULATED)).toBe(true)
  })
})
