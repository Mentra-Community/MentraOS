import {storage} from "@/utils/storage"

import {localStorageService} from "./localStorageService"

const DOWNLOADED_FILES_KEY = "asg_downloaded_files"
const DOCS = "/tmp/documents"

function loadDownloadedFilesMetadata(): Record<string, {filePath: string; thumbnailPath?: string}> {
  const result = storage.load<Record<string, {filePath: string; thumbnailPath?: string}>>(DOWNLOADED_FILES_KEY)
  if (result.is_error()) {
    throw result.error
  }
  return result.value
}

describe("LocalStorageService gallery metadata", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    storage.clearAll()
  })

  it("saves new files without rewriting existing relative metadata as absolute paths", async () => {
    storage.save(DOWNLOADED_FILES_KEY, {
      IMG_existing: {
        name: "IMG_existing",
        filePath: "MentraPhotos/IMG_existing/base.jpg",
        size: 123,
        modified: 1000,
        mime_type: "image/jpeg",
        is_video: false,
        thumbnailPath: "MentraPhotos/IMG_existing/.thumb.jpg",
        downloaded_at: 1000,
      },
    })

    await localStorageService.saveDownloadedFile({
      name: "IMG_new",
      filePath: `${DOCS}/MentraPhotos/IMG_new/base.jpg`,
      size: 456,
      modified: 2000,
      mime_type: "image/jpeg",
      is_video: false,
      thumbnailPath: `${DOCS}/MentraPhotos/IMG_new/.thumb.jpg`,
      downloaded_at: 2000,
    })

    expect(loadDownloadedFilesMetadata()).toEqual({
      IMG_existing: expect.objectContaining({
        filePath: "MentraPhotos/IMG_existing/base.jpg",
        thumbnailPath: "MentraPhotos/IMG_existing/.thumb.jpg",
      }),
      IMG_new: expect.objectContaining({
        filePath: "MentraPhotos/IMG_new/base.jpg",
        thumbnailPath: "MentraPhotos/IMG_new/.thumb.jpg",
      }),
    })
  })
})
