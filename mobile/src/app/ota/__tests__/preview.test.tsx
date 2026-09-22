import {fireEvent, render} from "@testing-library/react-native"

import {OTA_PREVIEW_PAGES} from "@/components/dev/otaPreviewStates"
import {MentraLiveOtaPreview} from "@/../modules/engine/src/react/MentraLiveOtaFlow"
import * as otaHook from "@/../modules/engine/src/react/useMentraLiveOta"

test("every preview renders and its buttons leave the OTA runtime unmounted", () => {
  const runtime = jest.spyOn(otaHook, "useMentraLiveOta").mockImplementation(() => {
    throw new Error("Preview must not mount the OTA runtime")
  })
  try {
    for (const {state} of OTA_PREVIEW_PAGES) {
      const screen = render(<MentraLiveOtaPreview state={state} />)
      expect(screen.getByTestId("mentra-live-ota-flow")).toBeTruthy()
      for (const button of screen.queryAllByRole("button")) fireEvent.press(button)
      screen.unmount()
    }
    expect(runtime).not.toHaveBeenCalled()
  } finally {
    runtime.mockRestore()
  }
})
