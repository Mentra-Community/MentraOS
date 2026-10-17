import {coreEndpointOrigin} from "./endpointObservation"

it.each([
  ["https://core.dev.us-west-2.mentraglass.com", "official-dev"],
  ["https://core.staging.us-west-2.mentraglass.com/", "official-staging"],
  ["https://core.us-west-2.mentraglass.com", "official-prod"],
  ["https://core.dev.us-west-2.mentraglass.com.private.example", "custom"],
  ["https://private:secret@core.dev.us-west-2.mentraglass.com", "custom"],
  ["https://core.dev.us-west-2.mentraglass.com/private?token=secret", "custom"],
  ["http://core.dev.us-west-2.mentraglass.com", "custom"],
  ["http://192.0.2.10:3000", "custom"],
  ["file:///private/secret", "unknown"],
  ["not a URL", "unknown"],
  [null, "unknown"],
])("classifies %p using fixed public origin facts", (value, expected) => {
  expect(coreEndpointOrigin(value)).toBe(expected)
})
