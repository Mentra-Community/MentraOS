import {mapAuthError} from "./authErrors"

it.each([
  ["invalid_reset_link", "login:errors.invalidResetLink"],
  ["otp_expired", "login:errors.otpExpired"],
])("maps the sign-in screen's authError code %s to its message", (code, key) => {
  expect(mapAuthError(code)).toBe(key)
})

it.each(["constructor", "toString", "__proto__"])("treats a link's %s as an unknown error, not a code", (code) => {
  expect(typeof mapAuthError(code)).toBe("string")
  expect(mapAuthError(code)).not.toMatch(/^function/)
})
