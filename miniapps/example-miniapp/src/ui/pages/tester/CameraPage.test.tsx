import {beforeEach, describe, expect, mock, test} from "bun:test"
import {fireEvent, render, screen, waitFor} from "@testing-library/react"
import {MemoryRouter} from "react-router-dom"

const invokeMock = mock(async () => ({
  requestId: "photo-1",
  photoUrl: "https://example.com/photo.jpg",
  mimeType: "image/jpeg",
  size: 2048,
}))

mock.module("../../hooks/useTester", () => ({
  useTester: () => ({
    invoke: invokeMock,
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
    invokeMock.mockClear()
    invokeMock.mockImplementation(async (method: string) => {
      if (method === "warmUp") return undefined
      return {
        requestId: "photo-1",
        photoUrl: "https://example.com/photo.jpg",
        mimeType: "image/jpeg",
        size: 2048,
      }
    })
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
      expect(invokeMock).toHaveBeenCalledWith("warmUp", [{size: "medium", durationMs: 20000}])
    })
  })

  test("takePhoto sends the full new API options", async () => {
    render(
      <MemoryRouter>
        <CameraPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole("button", {name: "takePhoto()"}))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("takePhoto", [
        {
          size: "medium",
          mode: "photo",
          compress: "none",
          sound: true,
          saveToGallery: false,
        },
      ])
    })
    expect(await screen.findByText("photo-1")).toBeTruthy()
    expect(screen.getByText("2.0 KB")).toBeTruthy()
  })

  test("compare photo vs text captures both modes", async () => {
    render(
      <MemoryRouter>
        <CameraPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole("button", {name: "Compare photo vs text"}))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2)
    })
    expect(invokeMock).toHaveBeenNthCalledWith(1, "takePhoto", [
      {
        size: "medium",
        mode: "photo",
        compress: "none",
        sound: true,
        saveToGallery: false,
      },
    ])
    expect(invokeMock).toHaveBeenNthCalledWith(2, "takePhoto", [
      {
        size: "medium",
        mode: "text",
        compress: "none",
        sound: true,
        saveToGallery: false,
      },
    ])
  })
})
