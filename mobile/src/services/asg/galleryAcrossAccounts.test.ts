/* eslint-disable no-restricted-imports -- the engine gallery service is internal, as in cameraRollExportCoordinator.test.ts */
import {localStorageService} from "../../../modules/engine/src/services/asg/localStorageService"
import {closeAccountSettings, openAccountSettings} from "@/services/accountSettings"

// MMKV with one store per instance id, as on a phone: the account sets live outside the default instance.
const mockMmkvInstances = new Map<string, Map<string, string>>()
jest.mock("react-native-mmkv", () => ({
  createMMKV: (config?: {id?: string}) => {
    const id = config?.id ?? "mmkv.default"
    if (!mockMmkvInstances.has(id)) mockMmkvInstances.set(id, new Map())
    const values = mockMmkvInstances.get(id)!
    return {
      getString: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, String(value)),
      remove: (key: string) => values.delete(key),
      contains: (key: string) => values.has(key),
      getAllKeys: () => [...values.keys()],
      clearAll: () => values.clear(),
      trim: () => undefined,
    }
  },
}))

// The phone's Documents directory: the paths of the files on it.
const mockFiles = new Set<string>()
jest.mock("@dr.pogodin/react-native-fs", () => ({
  __esModule: true,
  DocumentDirectoryPath: "/docs",
  exists: jest.fn((path: string) =>
    Promise.resolve(mockFiles.has(path) || [...mockFiles].some((file) => file.startsWith(path + "/"))),
  ),
  mkdir: jest.fn(() => Promise.resolve()),
  unlink: jest.fn((path: string) => {
    for (const file of [...mockFiles]) if (file === path || file.startsWith(path + "/")) mockFiles.delete(file)
    return Promise.resolve()
  }),
}))

/** A photo synced from the glasses: its file and thumbnail in the shared photos directory, and the gallery's record. */
async function syncPhoto(name: string) {
  const filePath = `/docs/MentraPhotos/${name}`
  const thumbnailPath = `/docs/MentraPhotos/thumbnails/${name}`
  mockFiles.add(filePath)
  mockFiles.add(thumbnailPath)
  await localStorageService.saveDownloadedFile({
    name,
    filePath,
    thumbnailPath,
    size: 3,
    modified: 1,
    mime_type: "image/jpeg",
    is_video: false,
    downloaded_at: 1,
  } as Parameters<typeof localStorageService.saveDownloadedFile>[0])
}

/** A capture synced through the capture-aware pipeline: its folder holds the original, brackets and sidecar. */
async function syncCapture(captureId: string) {
  const dir = `/docs/MentraPhotos/${captureId}`
  for (const name of ["photo.jpg", "ev-2.jpg", "ev0.jpg", "ev2.jpg", "imu.json", ".thumb.jpg", "hdr.jpg"])
    mockFiles.add(`${dir}/${name}`)
  await localStorageService.saveDownloadedFile({
    name: captureId,
    filePath: `${dir}/hdr.jpg`,
    thumbnailPath: `${dir}/.thumb.jpg`,
    capture_id: captureId,
    size: 3,
    modified: 1,
    mime_type: "image/jpeg",
    is_video: false,
    downloaded_at: 1,
  } as Parameters<typeof localStorageService.saveDownloadedFile>[0])
}

const galleryNames = async () => Object.keys(await localStorageService.getDownloadedFiles()).sort()

beforeEach(() => {
  for (const values of mockMmkvInstances.values()) values.clear()
  mockFiles.clear()
})

describe("the gallery across accounts on one phone", () => {
  it("comes back for its account, and another account's Delete All Photos deletes only its own captures, every file of each", async () => {
    openAccountSettings("user-1")
    await syncPhoto("IMG_A.jpg")
    closeAccountSettings()

    openAccountSettings("user-2")
    expect(await galleryNames()).toEqual([])
    await syncPhoto("IMG_B.jpg")
    await syncCapture("cap_B")
    await localStorageService.clearAllFiles()
    expect(await galleryNames()).toEqual([])
    expect([...mockFiles].sort()).toEqual(["/docs/MentraPhotos/IMG_A.jpg", "/docs/MentraPhotos/thumbnails/IMG_A.jpg"])
    closeAccountSettings()

    openAccountSettings("user-1")
    const files = await localStorageService.getDownloadedFiles()
    expect(Object.keys(files)).toEqual(["IMG_A.jpg"])
    expect(files["IMG_A.jpg"].filePath).toBe("/docs/MentraPhotos/IMG_A.jpg")
    expect(mockFiles.has(files["IMG_A.jpg"].filePath)).toBe(true)
  })
})
