import ar from "./ar"
import en from "./en"
import es from "./es"
import fr from "./fr"
import hi from "./hi"
import ja from "./ja"
import ko from "./ko"

type Tree = {[key: string]: string | Tree}

const locales: Record<string, Tree> = {en, ar, es, fr, hi, ja, ko} as unknown as Record<string, Tree>
const translated = Object.entries(locales).filter(([code]) => code !== "en")

const flatten = (tree: Tree, prefix = ""): [string, string][] =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [[`${prefix}${key}`, value] as [string, string]] : flatten(value, `${prefix}${key}.`),
  )

const get = (tree: Tree, path: string): unknown => path.split(".").reduce<any>((node, key) => node?.[key], tree)

// "owner" and its everyday translations: the pairing flow never talks about ownership.
const OWNER_WORDS = /owner|propietari|dueñ|propriétaire|proprietaire|مالك|मालिक|स्वामी|オーナー|所有者|소유자|오너/i

const NEW_KEYS = [
  "pairing.livePairingScanTitle",
  "pairing.livePairingScanBody",
  "pairing.livePairingScanSearching",
  "pairing.pairingModeAlertTitle",
  "pairing.pairingModeAlertBody",
  "home.pairAgain",
  "onboarding.btClassicStep1",
  "onboarding.btClassicStep2",
  "onboarding.btClassicStep3",
  "onboarding.btClassicStep4",
  "onboarding.forgetIosPairingTitle",
  "onboarding.forgetIosPairingSubtitle",
  "onboarding.forgetIosPairingStep1",
  "onboarding.forgetIosPairingStep2",
  "onboarding.forgetIosPairingStep3",
]

const DELETED_KEYS = [
  "errors.pairingAlreadyOwner",
  "errors.iosForgetGlassesBluetooth",
  "pairing.livePairingModeTitle",
  "pairing.livePairingModeSubtitle",
  "pairing.replaceOwnerTitle",
  "pairing.replaceOwnerBody",
  "pairing.replaceOwnerConfirm",
  "pairing.replaceOwnerCancel",
]

describe("pairing copy audit", () => {
  it.each(Object.keys(locales))("%s has no user-facing string that mentions an owner", (code) => {
    // Workspace roles (the Fleet notice, Settings and last-Owner copy) are not pairing ownership.
    const offenders = flatten(locales[code]).filter(
      ([path, value]) => !path.startsWith("fleet.") && OWNER_WORDS.test(value),
    )
    expect(offenders).toEqual([])
  })

  it.each(Object.keys(locales))("%s has none of the deleted ownership-transfer keys", (code) => {
    const tree = locales[code]
    expect(DELETED_KEYS.filter((path) => get(tree, path) !== undefined)).toEqual([])
    const flat = flatten(tree).map(([path]) => path)
    expect(flat.filter((path) => /replaceOwner|liveOwnerLost/.test(path))).toEqual([])
  })

  it.each(Object.keys(locales))("%s defines every new key as a non-empty string", (code) => {
    for (const path of NEW_KEYS) {
      const value = get(locales[code], path)
      expect({path, value: typeof value}).toEqual({path, value: "string"})
      expect((value as string).length).toBeGreaterThan(0)
    }
  })

  it.each(translated)("%s translates every new key instead of falling back to English", (_code, tree) => {
    const untranslated = NEW_KEYS.filter((path) => get(tree, path) === get(en as unknown as Tree, path))
    expect(untranslated).toEqual([])
  })

  it.each(Object.keys(locales))("%s keeps the placeholders of the parameterised steps", (code) => {
    expect(get(locales[code], "onboarding.btClassicStep3")).toContain("{{name}}")
    expect(get(locales[code], "onboarding.forgetIosPairingStep2")).toContain("{{name}}")
  })

  it("keeps the exact English copy for the new screens", () => {
    expect(en.pairing.livePairingScanTitle).toBe("Put your glasses in pairing mode")
    expect(en.pairing.livePairingScanBody).toBe(
      "Press the power button 3 times quickly. Your glasses will say a 4-character code.",
    )
    expect(en.pairing.livePairingScanSearching).toBe("Looking for your glasses")
    expect(en.pairing.pairingModeAlertTitle).toBe("Your glasses are in pairing mode")
    expect(en.pairing.pairingModeAlertBody).toBe("Press the power button 3 times to exit.")
    expect(en.home.pairAgain).toBe("Pair Again")
    expect(en.onboarding.btClassicStep1).toBe("Tap Open Settings")
    expect(en.onboarding.btClassicStep2).toBe("Tap Bluetooth")
    expect(en.onboarding.btClassicStep3).toBe('Tap "{{name}}" under My Devices or Other Devices')
    expect(en.onboarding.btClassicStep4).toBe('Return to the app once it says "Connected"')
    expect(en.onboarding.forgetIosPairingTitle).toBe("Forget the old pairing")
    expect(en.onboarding.forgetIosPairingSubtitle).toBe(
      "Remove the saved Bluetooth pairing on your iPhone to continue.",
    )
    expect(en.onboarding.forgetIosPairingStep1).toBe("Open Settings, then tap Bluetooth.")
    expect(en.onboarding.forgetIosPairingStep2).toBe("Tap ⓘ next to {{name}}, then tap Forget This Device.")
    expect(en.onboarding.forgetIosPairingStep3).toBe("Return to the Mentra App to pair again.")
  })
})
