import {packagedOtaPin} from "./packagedOtaPin"

const env = "https://example.com/old.json"
const pin = "https://example.com/ota-pr-123-abcdef.json"

it("preserves official and local environment pins", () => {
  expect(packagedOtaPin(undefined, env)).toBe(env)
  expect(packagedOtaPin({}, " ")).toBeNull()
})

it("uses packaged config instead of a prior bundle's environment pin", () => {
  expect(packagedOtaPin({mentraBuild: {schemaVersion: 2, otaManifestUrl: pin}}, env)).toBe(pin)
  expect(packagedOtaPin({mentraBuild: {schemaVersion: 2, otaManifestUrl: null}}, env)).toBeNull()
  expect(packagedOtaPin({mentraBuild: {schemaVersion: 2, otaManifestUrl: ""}}, env)).toBeNull()
})

it.each([null, {}, {schemaVersion: 1}, {schemaVersion: 2}, {schemaVersion: 2, otaManifestUrl: "file:///tmp/a"}])(
  "rejects malformed packaged config without falling back to a stale pin: %j",
  (mentraBuild) => expect(() => packagedOtaPin({mentraBuild}, env)).toThrow(),
)
