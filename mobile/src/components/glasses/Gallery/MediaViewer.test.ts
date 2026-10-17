import {PhotoInfo} from "@/types/asg"

import {createMediaViewerSnapshot} from "./MediaViewer"

jest.mock("./AwesomeGalleryViewer", () => ({
  AwesomeGalleryViewer: () => null,
}))

describe("createMediaViewerSnapshot", () => {
  const first = {name: "first.jpg"} as PhotoInfo
  const selected = {name: "selected.jpg"} as PhotoInfo
  const allViewable = () => true

  it("returns the selected index in a compact media snapshot", () => {
    expect(createMediaViewerSnapshot([undefined, first, selected], selected.name, allViewable)).toEqual({
      photos: [first, selected],
      initialIndex: 1,
    })
  })

  it("refuses to open a stale selection instead of showing another photo", () => {
    expect(createMediaViewerSnapshot([first], selected.name, allViewable)).toBeNull()
  })

  it("swipes past media still transferring to the next item already on the phone", () => {
    const downloaded = {name: "downloaded.jpg", filePath: "/photos/downloaded.jpg"} as PhotoInfo
    const transferringVideo = {name: "transferring.mp4", is_video: true} as PhotoInfo
    const pending = {name: "pending.jpg"} as PhotoInfo
    const older = {name: "older.jpg", filePath: "/photos/older.jpg"} as PhotoInfo

    expect(
      createMediaViewerSnapshot(
        [downloaded, transferringVideo, pending, older],
        downloaded.name,
        (photo) => !!photo.filePath,
      ),
    ).toEqual({photos: [downloaded, older], initialIndex: 0})
  })

  it("keeps the selected item even when it is not on the phone yet", () => {
    const remote = {name: "remote.jpg"} as PhotoInfo
    const downloaded = {name: "downloaded.jpg", filePath: "/photos/downloaded.jpg"} as PhotoInfo

    expect(createMediaViewerSnapshot([downloaded, remote], remote.name, (photo) => !!photo.filePath)).toEqual({
      photos: [downloaded, remote],
      initialIndex: 1,
    })
  })
})
