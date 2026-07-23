/* eslint-disable no-restricted-imports */
import {gallery} from "../../modules/engine/src/facades/gallery"
import {useGallerySyncStore} from "../../modules/engine/src/stores/gallerySync"

describe("gallery facade", () => {
  beforeEach(() => {
    useGallerySyncStore.getState().reset()
  })

  it("projects sync queue and processing state without exposing the raw store", () => {
    useGallerySyncStore.getState().setSyncing([
      {
        name: "photo.jpg",
        url: "http://glasses/photo.jpg",
        download: "http://glasses/photo.jpg",
        size: 100,
        modified: 1,
      },
    ])
    useGallerySyncStore.getState().onFileProcessing("photo.jpg")

    expect(gallery.status()).toEqual(
      expect.objectContaining({
        syncState: "syncing",
        queueLength: 1,
        processingFiles: ["photo.jpg"],
        queue: [expect.objectContaining({name: "photo.jpg"})],
      }),
    )
  })

  it("wraps queue cleanup commands", () => {
    useGallerySyncStore.getState().setSyncing([
      {
        name: "photo.jpg",
        url: "http://glasses/photo.jpg",
        download: "http://glasses/photo.jpg",
        size: 100,
        modified: 1,
      },
    ])

    gallery.clearQueue()

    expect(gallery.status()).toEqual(expect.objectContaining({queueLength: 0, queue: []}))
  })

  it("publishes preflight start completion through the reactive status surface", () => {
    const statuses: Array<{isStarting: boolean}> = []
    const unsubscribe = gallery.onStatus((status) => statuses.push(status))

    useGallerySyncStore.getState().setSyncStarting(true)
    expect(gallery.status().isStarting).toBe(true)

    useGallerySyncStore.getState().setSyncStarting(false)
    unsubscribe()

    expect(statuses.map(({isStarting}) => isStarting)).toEqual([true, false])
    expect(gallery.status().isStarting).toBe(false)
  })
})
