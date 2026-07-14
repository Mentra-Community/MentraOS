import {beforeEach, describe, expect, mock, test} from "bun:test"
import {fireEvent, render, screen, waitFor} from "@testing-library/react"
import {MemoryRouter} from "react-router-dom"

const photoResult = {
  requestId: "photo-1",
  photoUrl: "https://example.com/photo.jpg",
  mimeType: "image/jpeg",
  size: 2048,
}
const cameraInvokeMock = mock(async () => photoResult)
const systemInvokeMock = mock(async () => ({success: true}))

mock.module("../../hooks/useTester", () => ({
  useTester: (iface: string) => ({
    invoke: iface === "system" ? systemInvokeMock : cameraInvokeMock,
    lastError: null,
    log: [],
    clearLog: () => {},
  }),
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
      expect(cameraInvokeMock).toHaveBeenCalledWith("warmUp", [{size: "medium", durationMs: 20000}])
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
        },
      ])
    })
    expect(await screen.findByText("photo-1")).toBeTruthy()
    expect(screen.getByText("2.0 KB")).toBeTruthy()
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
