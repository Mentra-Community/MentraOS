/* eslint-disable no-restricted-imports -- Exercise the real gallery status projection behind the public engine API. */
import {engine} from "@mentra/engine"
import {act, render} from "@testing-library/react-native"

import AsgGallerySettings from "@/app/asg/gallery-settings"
import MiniappGallerySettings from "@/app/miniapps/gallery/gallery-settings"
import {gallery} from "../../../../modules/engine/src/facades/gallery"
import {useGallerySyncStore} from "../../../../modules/engine/src/stores/gallerySync"

let mockItems: Array<{label: string; value: string}> = []
jest.mock("@/components/ui/InfoCard", () => ({
  __esModule: true,
  default: ({items}: {items: typeof mockItems}) => {
    mockItems = items
    return null
  },
}))
jest.mock("@/components/glasses/Gallery/GalleryCameraRollSetting", () => ({GalleryCameraRollSetting: () => null}))
jest.mock("@/components/ui/RouteButton", () => ({RouteButton: () => null}))
jest.mock("@mentra/engine-host-internal", () => ({
  cameraRollExportCoordinator: {},
  localStorageService: {getDownloadedFiles: jest.fn(async () => ({}))},
}))

describe.each([
  ["ASG", AsgGallerySettings],
  ["miniapp", MiniappGallerySettings],
])("%s gallery settings", (_name, Screen) => {
  beforeEach(() => {
    useGallerySyncStore.getState().reset()
    jest.mocked(engine.glasses.status).mockReturnValue({...engine.glasses.status(), state: "connected"})
    Object.assign(engine.gallery, {
      status: jest.fn(gallery.status),
      onStatus: jest.fn(gallery.onStatus),
      refreshStatus: jest.fn(async () => {}),
    })
  })

  it("shows reported counts, updates while open, and displays zero for empty glasses", async () => {
    useGallerySyncStore.getState().setGlassesGalleryStatus(2, 1, 3, true)
    render(<Screen />)
    await act(async () => {})
    expect(mockItems.slice(2, 4).map((item) => item.value)).toEqual(["2", "1"])
    expect(engine.gallery.refreshStatus).toHaveBeenCalledTimes(1)
    act(() => {
      useGallerySyncStore.getState().setGlassesGalleryStatus(3, 2, 5, true)
    })
    expect(mockItems.slice(2, 4).map((item) => item.value)).toEqual(["3", "2"])
    act(() => {
      useGallerySyncStore.getState().setGlassesGalleryStatus(0, 0, 0, false)
    })
    expect(mockItems.slice(2, 4).map((item) => item.value)).toEqual(["0", "0"])
  })

  it("does not display stale counts or query glasses when disconnected", async () => {
    jest.mocked(engine.glasses.status).mockReturnValue({...engine.glasses.status(), state: "disconnected"})
    useGallerySyncStore.getState().setGlassesGalleryStatus(2, 1, 3, true)
    render(<Screen />)
    await act(async () => {})
    expect(mockItems.slice(2, 4).map((item) => item.value)).toEqual(["—", "—"])
    expect(engine.gallery.refreshStatus).not.toHaveBeenCalled()
  })
})
