import {fireEvent, render} from "@testing-library/react-native"

import LanguageSelector from "./LanguageSelector"

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({
    theme: {colors: {foreground: "black", textDim: "gray"}},
    themed: () => ({}),
  }),
}))
jest.mock("@/components/ignite", () => {
  const React = require("react")
  const {Text, View} = require("react-native")
  return {Text: ({text}: {text: string}) => React.createElement(Text, null, text), Icon: View}
})
jest.mock("@/components/ui/Group", () => {
  const React = require("react")
  const {Text, View} = require("react-native")
  return {
    Group: ({title, children}: {title: string; children: unknown}) =>
      React.createElement(View, null, React.createElement(Text, null, title), children),
  }
})
jest.mock("@mentra/engine-host-internal", () => ({STTModelManager: {formatBytes: () => "55 MB"}}))
jest.mock("@/components/ui/GlassView", () => {
  const {View} = require("react-native")
  return {__esModule: true, default: View}
})

const languages = [
  {code: "en-kroko", displayName: "English", size: 55, downloaded: true},
  {code: "fr", displayName: "Français", size: 57, downloaded: false},
]

describe("speech model list", () => {
  it("lists every language as a plain row and forwards the tapped code", () => {
    const onPick = jest.fn()
    const screen = render(
      <LanguageSelector
        title="Speech-to-text language"
        languages={languages}
        currentLanguage="en-kroko"
        onPickLanguage={onPick}
      />,
    )
    expect(screen.getByText("Speech-to-text language")).toBeTruthy()
    expect(screen.getByText("55 MB · In use")).toBeTruthy()
    expect(screen.getByText("55 MB · Tap to download")).toBeTruthy()
    fireEvent.press(screen.getByText("Français"))
    expect(onPick).toHaveBeenCalledWith("fr")
  })

  it("shows download progress on the downloading row", () => {
    const screen = render(
      <LanguageSelector
        title="Speech-to-text language"
        languages={languages}
        currentLanguage="en-kroko"
        downloadingLanguage="fr"
        downloadPercent={42}
        onPickLanguage={jest.fn()}
      />,
    )
    expect(screen.getByText("Downloading… 42%")).toBeTruthy()
  })

  it("a model without an in-use choice shows its downloaded hint", () => {
    const screen = render(
      <LanguageSelector
        title="Wake word"
        languages={[{code: "hey-mentra", displayName: "Hey Mentra", size: 33, downloaded: true}]}
        currentLanguage=""
        downloadedHint="Tap to delete"
        onPickLanguage={jest.fn()}
      />,
    )
    expect(screen.getByText("55 MB · Tap to delete")).toBeTruthy()
  })
})
