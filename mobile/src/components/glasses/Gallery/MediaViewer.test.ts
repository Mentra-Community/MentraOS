import {PhotoInfo} from "@/types/asg"

import {createMediaViewerSnapshot} from "./MediaViewer"

jest.mock("./AwesomeGalleryViewer", () => ({
  AwesomeGalleryViewer: () => null,
}))

describe("createMediaViewerSnapshot", () => {
  const first = {name: "first.jpg"} as PhotoInfo
  const selected = {name: "selected.jpg"} as PhotoInfo

  it("returns the selected index in a compact media snapshot", () => {
    expect(createMediaViewerSnapshot([undefined, first, selected], selected.name)).toEqual({
      photos: [first, selected],
      initialIndex: 1,
    })
  })

  it("refuses to open a stale selection instead of showing another photo", () => {
    expect(createMediaViewerSnapshot([first], selected.name)).toBeNull()
  })
})
