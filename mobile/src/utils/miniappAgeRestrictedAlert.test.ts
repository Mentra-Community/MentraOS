import {showAlert} from "@/contexts/ModalContext"
import {showMiniappAgeRestrictedAlert} from "@/utils/miniappAgeRestrictedAlert"

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

describe("the age-restricted alert", () => {
  beforeEach(() => jest.mocked(showAlert).mockClear())

  test("names the miniapp and its rating, kindly", () => {
    showMiniappAgeRestrictedAlert({
      packageName: "com.acme.club",
      name: "Night Club",
      ageRating: "18+",
      reason: "too_young",
    })
    expect(showAlert).toHaveBeenCalledWith({
      title: "Night Club is rated 18+.",
      message: "It isn't available for your age.",
      buttons: [{text: "OK"}],
    })
  })

  test("falls back to the package name for a miniapp without one", () => {
    showMiniappAgeRestrictedAlert({packageName: "com.acme.club", name: "", ageRating: "16+", reason: "too_young"})
    expect(jest.mocked(showAlert).mock.calls[0][0].title).toBe("com.acme.club is rated 16+.")
  })

  test("says to connect when the age couldn't be checked", () => {
    showMiniappAgeRestrictedAlert({
      packageName: "com.acme.club",
      name: "Night Club",
      ageRating: "18+",
      reason: "unavailable",
    })
    expect(showAlert).toHaveBeenCalledWith({
      title: "We couldn't check your age",
      message: "Connect to the internet and try again.",
      buttons: [{text: "OK"}],
    })
  })
})
