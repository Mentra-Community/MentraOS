import {fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import en from "@/i18n/en"
import GlassesTroubleshootingModal, {getModelSpecificTips} from "./GlassesTroubleshootingModal"

jest.mock("react-native-vector-icons/MaterialIcons", () => () => null)
jest.mock("@/utils/getGlassesImage", () => ({getGlassesImage: () => 1}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => {
    const theme = {colors: {}, spacing: {s2: 8, s3: 12, s4: 16, s6: 24}}
    return {theme, themed: (style: (value: typeof theme) => unknown) => style(theme)}
  },
}))
jest.mock("@/i18n", () => ({
  translate: (key: string) => {
    const [namespace, name] = key.split(":")
    return require("@/i18n/en").default[namespace][name]
  },
}))
jest.mock("@/components/ignite", () => {
  const {Text, TouchableOpacity} = require("react-native")
  return {
    Text: ({text, children}: {text?: string; children?: ReactNode}) => <Text>{text ?? children}</Text>,
    Button: ({text, onPress, disabled}: {text: string; onPress: () => void; disabled?: boolean}) => (
      <TouchableOpacity onPress={onPress} disabled={disabled}>
        <Text>{text}</Text>
      </TouchableOpacity>
    ),
  }
})

describe("Even touchpad reset instructions", () => {
  it("shows only the simultaneous G2 touchpad method and the older-hardware note", () => {
    const onClose = jest.fn()
    const screen = render(<GlassesTroubleshootingModal isVisible onClose={onClose} deviceModel="Even Realities G2" />)
    expect(screen.getByText(en.pairing.g2ResetTitle)).toBeTruthy()
    expect(screen.getByText(`${en.pairing.g2ResetInstructions}\n\n${en.pairing.g2ResetOlderHardware}`)).toBeTruthy()
    expect(screen.getByText(/While wearing.*quickly tap both touchpads 5 times simultaneously.*low tone/)).toBeTruthy()
    expect(screen.queryByText(/plug and unplug|10 seconds/)).toBeNull()
    fireEvent.press(screen.getByText("Done"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("keeps the powered charger requirement specific to the R1 reset", () => {
    const screen = render(<GlassesTroubleshootingModal isVisible onClose={jest.fn()} deviceModel="Even Realities R1" />)
    expect(screen.getByText(en.pairing.r1ResetTitle)).toBeTruthy()
    expect(screen.getByText(en.pairing.r1ResetInstructions)).toBeTruthy()
    expect(screen.getByText(/charger plugged into power.*touchpad 5 times/)).toBeTruthy()
    expect(screen.queryByText(/both touchpads|wearing your G2s|low tone/)).toBeNull()
  })

  it("preserves the separate G1 troubleshooting tips", () => {
    const tips = getModelSpecificTips("Even Realities G1")
    expect(tips.some((tip) => tip.title === "Fold Left Arm Before Right")).toBe(true)
    expect(tips.some((tip) => tip.body.includes("5 times"))).toBe(false)
  })

  describe("Mentra Live paired to another phone", () => {
    afterEach(() => {
      delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING
    })

    it("tells users to press three times when secure pairing is enabled", () => {
      process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING = "true"
      const tips = getModelSpecificTips("Mentra Live")
      expect(tips).toContainEqual({title: en.pairing.liveOtherPhoneTipTitle, body: en.pairing.liveOtherPhoneTipBody})
    })

    it("keeps the legacy tip when secure pairing is disabled", () => {
      process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING = "false"
      const tips = getModelSpecificTips("Mentra Live")
      expect(tips.some((tip) => tip.title === en.pairing.liveOtherPhoneTipTitle)).toBe(false)
      expect(tips.some((tip) => tip.title === "Pairing Mode")).toBe(true)
    })
  })

  it.each(["Even Realities G2", "Even Realities R1"])(
    "does not suggest a reset in the normal pairing loader for %s",
    (model) => {
      const tips = getModelSpecificTips(model)
      expect(tips.some((tip) => /5 times|reset/i.test(tip.body))).toBe(false)
    },
  )
})
