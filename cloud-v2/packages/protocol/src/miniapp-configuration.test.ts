import {describe, expect, test} from "bun:test"
import {
  ConfigurationDeclarationSchema,
  configurationFiles,
  mergeConfiguration,
  readConfigurationDeclaration,
  type ConfigurationDeclaration,
} from "./miniapp-configuration"

const FORM = {name: "DVI.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 10, sha256: "a".repeat(64)}

const declaration = ConfigurationDeclarationSchema.parse([
  {key: "backendUrl", type: "url", default: "https://shipped.example", setBy: ["workspace"]},
  {key: "photos", type: "choice", options: ["manual", "auto"], default: "manual", setBy: ["deployment", "workspace"]},
  {
    key: "modes",
    type: "list",
    merge: "append",
    setBy: ["deployment", "workspace", "person"],
    fields: [
      {key: "name", type: "string"},
      {key: "form", type: "file"},
    ],
    default: [{name: "Built in"}],
  },
]) as ConfigurationDeclaration

describe("managed miniapp settings", () => {
  test("a key takes the highest layer its setBy allows", () => {
    const merged = mergeConfiguration(declaration, {deployment: {photos: "auto"}, workspace: {photos: "manual"}})
    expect(merged.values.photos).toBe("manual")
    expect(merged.sources.photos).toBe("workspace")
  })

  test("backendUrl comes from a deployment only, whatever the declaration says", () => {
    const merged = mergeConfiguration(declaration, {workspace: {backendUrl: "https://elsewhere.example"}})
    expect(merged.values.backendUrl).toBe("https://shipped.example")
    expect(merged.rejected.workspace).toEqual(["backendUrl"])
  })

  test("an appended list keeps every layer's items, each tagged with its layer", () => {
    const merged = mergeConfiguration(declaration, {workspace: {modes: [{name: "DVI", form: FORM}]}})
    expect(merged.values.modes).toEqual([
      {name: "Built in", source: "shipped"},
      {name: "DVI", form: FORM, source: "workspace"},
    ])
    expect(configurationFiles(declaration, merged.values)).toEqual([FORM])
  })

  test("a value of the wrong type or an undeclared key is left out", () => {
    const merged = mergeConfiguration(declaration, {workspace: {photos: "sometimes", other: "x"}})
    expect(merged.values.photos).toBe("manual")
    expect(merged.rejected.workspace).toEqual(["photos", "other"])
  })

  test("without a declaration, only the deployment's strings pass, as before", () => {
    const merged = mergeConfiguration(null, {deployment: {backendUrl: "https://acme.example", flag: true}, workspace: {x: "y"}})
    expect(merged.values).toEqual({backendUrl: "https://acme.example"})
  })

  test("a declaration whose default doesn't match its type is invalid", () => {
    expect(readConfigurationDeclaration({configuration: [{key: "n", type: "number", default: "1"}]})).toBeNull()
  })
})
