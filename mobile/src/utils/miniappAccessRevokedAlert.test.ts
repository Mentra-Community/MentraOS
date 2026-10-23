import {showAlert} from "@/contexts/ModalContext"
import {showMiniappAccessRevokedAlert} from "@/utils/miniappAccessRevokedAlert"

jest.mock("@/contexts/ModalContext", () => ({showAlert: jest.fn(async () => 0)}))
// Render the English source strings so the test reads the copy users see.
jest.mock("@/i18n", () => {
  const en = jest.requireActual("@/i18n/en").default as Record<string, Record<string, string>>
  return {
    translate: (key: string, params: Record<string, string> = {}) => {
      const [scope, name] = key.split(":")
      return Object.entries(params).reduce(
        (text, [param, value]) => text.replace(`{{${param}}}`, value),
        en[scope][name],
      )
    },
  }
})

describe("access revoked alert", () => {
  beforeEach(() => jest.mocked(showAlert).mockClear())

  test("names the miniapp and says nothing more", () => {
    showMiniappAccessRevokedAlert({packageName: "com.acme.notes", name: "Notes"})
    expect(showAlert).toHaveBeenCalledWith({
      title: "You no longer have access to Notes.",
      buttons: [{text: "OK"}],
    })
  })

  test("falls back to the package name for a miniapp without one", () => {
    showMiniappAccessRevokedAlert({packageName: "com.acme.notes", name: ""})
    expect(jest.mocked(showAlert).mock.calls[0][0].title).toBe("You no longer have access to com.acme.notes.")
  })
})
