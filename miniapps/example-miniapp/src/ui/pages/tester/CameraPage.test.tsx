import {beforeEach, describe, expect, mock, test} from "bun:test"
import {useSyncExternalStore} from "react"
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react"
import {MemoryRouter} from "react-router-dom"

import {DEFAULT_WARMUP_DURATION_MS} from "./cameraPageModel"

const photoResult = {
  requestId: "photo-1",
  photoUrl: "https://example.com/photo.jpg",
  mimeType: "image/jpeg",
  size: 2048,
}
const cameraInvokeMock = mock(async () => photoResult)
const systemInvokeMock = mock(async () => ({success: true}))

// Tiny external store so tests can push tester:event payloads (button
// presses) into the mocked useTester("input") the same way the real hook
// streams them.
type TesterEvent = {iface: string; kind: string; payload: unknown}
let latestInputEvent: TesterEvent | null = null
const inputListeners = new Set<() => void>()
function emitInputEvent(event: TesterEvent) {
  latestInputEvent = event
  for (const listener of inputListeners) listener()
}

mock.module("../../hooks/useTester", () => ({
  useTester: (iface: string) => {
    const latest = useSyncExternalStore(
      (onStoreChange) => {
        inputListeners.add(onStoreChange)
        return () => inputListeners.delete(onStoreChange)
      },
      () => (iface === "input" ? latestInputEvent : null),
    )
    return {
      invoke: iface === "system" ? systemInvokeMock : cameraInvokeMock,
      latest,
      latestByKind: () => null,
      lastError: null,
      log: [],
      clearLog: () => {},
    }
  },
}))

mock.module("../../hooks/useChannel", () => ({
  useChannel: () => ({
    capabilities: {hasCamera: true, modelName: "Mentra Live"},
  }),
}))

const {default: CameraPage} = await import("./CameraPage")

describe("CameraPage", () => {
  beforeEach(() => {
    cameraInvokeMock.mockClear()
    cameraInvokeMock.mockImplementation(async (method: string) => {
      if (method === "warmUp") return undefined
      return photoResult
    })
    systemInvokeMock.mockClear()
    systemInvokeMock.mockImplementation(async () => ({success: true}))
    latestInputEvent = null
  })

  test("warmUp sends the selected size and duration", async () => {
    render(
      <MemoryRouter>
        <CameraPage />
      </MemoryRouter>,
    )

    fireEvent.change(screen.getByLabelText("warmUp durationMs"), {target: {value: "20000"}})
    fireEvent.click(screen.getByRole("button", {name: /warmUp\(/}))

    await waitFor(() => {
      expect(cameraInvokeMock).toHaveBeenCalledWith("warmUp", [
        {size: "medium", mode: "photo", durationMs: 20000},
      ])
    })
  })

  test("text mode hides quality and warms with mode=text", async () => {
    render(
      <MemoryRouter>
        <CameraPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByLabelText("mode"))
    fireEvent.click(await screen.findByRole("option", {name: "text"}))

    expect(screen.queryByLabelText("quality")).toBeNull()
    fireEvent.click(screen.getByRole("button", {name: /warmUp\(/}))

    await waitFor(() => {
      expect(cameraInvokeMock).toHaveBeenCalledWith("warmUp", [
        {size: "medium", mode: "text", durationMs: DEFAULT_WARMUP_DURATION_MS},
      ])
    })

    fireEvent.click(screen.getByRole("button", {name: "takePhoto()"}))
    await waitFor(() => {
      expect(cameraInvokeMock).toHaveBeenCalledWith("takePhoto", [
        {size: "medium", mode: "text", zsl: true, mfnr: true},
      ])
    })
  })

  test("takePhoto sends the selected camera options", async () => {
    render(
      <MemoryRouter>
        <CameraPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole("button", {name: "takePhoto()"}))

    await waitFor(() => {
      expect(cameraInvokeMock).toHaveBeenCalledWith("takePhoto", [
        {
          size: "medium",
          mode: "photo",
          zsl: true,
          mfnr: true,
        },
      ])
    })
    expect(await screen.findByText("photo-1")).toBeTruthy()
    expect(screen.getByText("2.0 KB")).toBeTruthy()
  })

  test("takePhoto sends zsl and mfnr false when the toggles are off", async () => {
    render(
      <MemoryRouter>
        <CameraPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole("switch", {name: "zsl"}))
    fireEvent.click(screen.getByRole("switch", {name: "mfnr"}))
    fireEvent.click(screen.getByRole("button", {name: "takePhoto()"}))

    await waitFor(() => {
      expect(cameraInvokeMock).toHaveBeenCalledWith("takePhoto", [
        {
          size: "medium",
          mode: "photo",
          zsl: false,
          mfnr: false,
        },
      ])
    })
  })

  test("glasses button press captures with the same options as the takePhoto button", async () => {
    render(
      <MemoryRouter>
        <CameraPage />
      </MemoryRouter>,
    )

    act(() => {
      emitInputEvent({iface: "input", kind: "button", payload: {buttonId: "camera", pressType: "short"}})
    })

    await waitFor(() => {
      expect(cameraInvokeMock).toHaveBeenCalledWith("takePhoto", [
        {
          size: "medium",
          mode: "photo",
          zsl: true,
          mfnr: true,
        },
      ])
    })
    expect(await screen.findByText("photo-1")).toBeTruthy()
  })

  test("button press is ignored while a capture is already pending", async () => {
    let resolveCapture: (value: typeof photoResult) => void = () => {}
    cameraInvokeMock.mockImplementationOnce(
      () => new Promise<typeof photoResult>((resolve) => (resolveCapture = resolve)),
    )
    render(
      <MemoryRouter>
        <CameraPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole("button", {name: "takePhoto()"}))
    act(() => {
      emitInputEvent({iface: "input", kind: "button", payload: {buttonId: "camera", pressType: "short"}})
    })

    expect(cameraInvokeMock).toHaveBeenCalledTimes(1)
    act(() => resolveCapture(photoResult))
    expect(await screen.findByText("photo-1")).toBeTruthy()
  })

  test("non-button input events do not trigger a capture", async () => {
    render(
      <MemoryRouter>
        <CameraPage />
      </MemoryRouter>,
    )

    act(() => {
      emitInputEvent({iface: "input", kind: "touch", payload: {gesture: "swipe"}})
    })

    expect(cameraInvokeMock).not.toHaveBeenCalled()
  })

  test("shares the latest photo through session.system.download", async () => {
    render(
      <MemoryRouter>
        <CameraPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole("button", {name: "takePhoto()"}))
    fireEvent.click(await screen.findByRole("button", {name: "Share image"}))

    await waitFor(() => {
      expect(systemInvokeMock).toHaveBeenCalledWith("download", [
        {
          url: photoResult.photoUrl,
          mimeType: photoResult.mimeType,
          filename: "mentra-photo-photo-1.jpg",
        },
      ])
    })
  })

  test("surfaces a resolved download failure", async () => {
    systemInvokeMock.mockImplementationOnce(async () => ({success: false}))
    render(
      <MemoryRouter>
        <CameraPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole("button", {name: "takePhoto()"}))
    fireEvent.click(await screen.findByRole("button", {name: "Share image"}))

    expect(await screen.findByText(/The image could not be shared\./)).toBeTruthy()
  })
})
