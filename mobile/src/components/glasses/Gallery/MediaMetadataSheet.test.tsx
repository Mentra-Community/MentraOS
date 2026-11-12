import {act, render} from "@testing-library/react-native"

import {PhotoInfo} from "@/types/asg"

import {loadMediaMetadata} from "./loadMediaMetadata"
import {MediaMetadataSheet} from "./MediaMetadataSheet"

let mockBottomSheetProps: Record<string, unknown> = {}

jest.mock("@gorhom/bottom-sheet", () => {
  const React = require("react")
  const {View} = require("react-native")
  const BottomSheet = React.forwardRef((props: Record<string, unknown>, _ref: unknown) => {
    mockBottomSheetProps = props
    return React.createElement(View, null, props.children)
  })
  BottomSheet.displayName = "BottomSheet"
  return {
    __esModule: true,
    default: BottomSheet,
    BottomSheetBackdrop: () => null,
    BottomSheetScrollView: ({children}: {children: React.ReactNode}) => React.createElement(View, null, children),
  }
})

jest.mock("./loadMediaMetadata", () => ({
  loadMediaMetadata: jest.fn(),
}))
jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => () => null)

describe("MediaMetadataSheet", () => {
  it("mounts closed without animation and enables Android pan-to-dismiss gestures", () => {
    const bottomSheetRef = {current: null}
    const photo = {name: "photo.jpg", filePath: "/gallery/photo.jpg", is_video: false} as PhotoInfo

    render(
      <MediaMetadataSheet
        bottomSheetRef={bottomSheetRef}
        photo={photo}
        dimensions={{width: 1920, height: 1080}}
        topInset={96}
        onChange={jest.fn()}
      />,
    )

    expect(mockBottomSheetProps).toMatchObject({
      animateOnMount: false,
      enableContentPanningGesture: true,
      enableHandlePanningGesture: true,
      enablePanDownToClose: true,
      index: -1,
      topInset: 96,
    })
  })

  it("shows the resolution stored in the photo rather than the downscaled preview", async () => {
    ;(loadMediaMetadata as jest.Mock).mockResolvedValue({dimensions: {width: 4032, height: 3024}, exif: null})
    const photo = {name: "photo.jpg", filePath: "/gallery/photo.jpg", is_video: false} as PhotoInfo

    const view = render(
      <MediaMetadataSheet
        bottomSheetRef={{current: null}}
        photo={photo}
        dimensions={{width: 1080, height: 810}}
        topInset={0}
        onChange={jest.fn()}
      />,
    )
    expect(view.queryByText("1080 × 810")).toBeNull()

    await act(async () => (mockBottomSheetProps.onChange as (index: number) => void)(0))

    expect(view.getByText("4032 × 3024")).toBeTruthy()
    expect(view.queryByText("1080 × 810")).toBeNull()
  })
})
