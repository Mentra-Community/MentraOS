import type {ClientApp} from "@mentra/engine"

import {getDefaultMenuApps} from "./glassesMenu"

function app(packageName: string, overrides: Partial<ClientApp> = {}): ClientApp {
  return {
    packageName,
    name: packageName,
    hidden: false,
    compatibility: {isCompatible: true, missingRequired: [], missingOptional: [], warnings: []},
    ...overrides,
  } as ClientApp
}

describe("getDefaultMenuApps", () => {
  it("keeps glasses-facing SYSTEM miniapps eligible while excluding host utilities", async () => {
    const menu = await getDefaultMenuApps([
      app("com.mentra.camera"),
      app("com.mentra.notes"),
      app("com.mentra.translation"),
      app("com.example.hidden", {hidden: true}),
      app("com.example.incompatible", {
        compatibility: {isCompatible: false, missingRequired: [], missingOptional: [], warnings: []},
      }),
    ])

    expect(menu.map(({packageName}) => packageName)).toEqual(["com.mentra.translation", "com.mentra.notes"])
  })
})
