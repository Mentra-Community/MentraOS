import {confirmLinkSignIn} from "./confirmLinkSignIn"

const mockShowAlert = jest.fn()
jest.mock("@/contexts/ModalContext", () => ({showAlert: (...args: unknown[]) => mockShowAlert(...args)}))
jest.mock("@/i18n", () => ({
  translate: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
}))

beforeEach(() => mockShowAlert.mockReset())

it("names both accounts when the link would switch accounts, and accepts only Sign in", async () => {
  mockShowAlert.mockResolvedValue(1)
  await expect(confirmLinkSignIn({email: "other@example.test", current: {email: "me@example.test"}})).resolves.toBe(
    true,
  )
  const [{message, buttons}] = mockShowAlert.mock.calls[0]
  expect(message).toContain("me@example.test")
  expect(message).toContain("other@example.test")
  expect(message).toContain("login:linkSignInSwitchMessage")
  expect(buttons.map((b: {text: string}) => b.text)).toEqual(["common:cancel", "login:linkSignInContinue"])
})

it.each([0, -1])("declines on Cancel, dismissal or no alert host (%p)", async (answer) => {
  mockShowAlert.mockResolvedValue(answer)
  await expect(confirmLinkSignIn({email: "other@example.test", current: null})).resolves.toBe(false)
  expect(mockShowAlert.mock.calls[0][0].message).toContain("login:linkSignInMessage")
  expect(mockShowAlert.mock.calls[0][0].message).toContain("other@example.test")
})
