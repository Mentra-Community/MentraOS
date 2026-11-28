import {GlobalRegistrator} from "@happy-dom/global-registrator"
import {afterAll, beforeAll, expect, mock, test} from "bun:test"
import {act} from "react"
import {createRoot} from "react-dom/client"

import {LanguageSelector} from "./LanguageSelector"

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => GlobalRegistrator.unregister())

test("a resent copy of the saved settings keeps the pick until Save", async () => {
  const onSave = mock(async (_language: string, _hints: string[]) => {})
  const root = createRoot(document.body.appendChild(document.createElement("div")))
  const render = () =>
    root.render(<LanguageSelector currentLanguage="auto" currentHints={[]} onSave={onSave} onCancel={() => {}} />)
  const press = (text: string) =>
    [...document.querySelectorAll("button")].find((button) => button.textContent?.includes(text))!.click()

  await act(render)
  await act(() => press("Français"))
  await act(render) // the background's resync: equal settings, a new hints array
  await act(async () => press("Save"))

  expect(onSave).toHaveBeenCalledWith("fr", [])
  await act(() => root.unmount())
})
