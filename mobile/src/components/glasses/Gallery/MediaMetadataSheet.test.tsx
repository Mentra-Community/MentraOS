import {render} from "@testing-library/react-native"

import {PhotoInfo} from "@/types/asg"

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
        onChange={jest.fn()}
      />,
    )

    expect(mockBottomSheetProps).toMatchObject({
      animateOnMount: false,
      enableContentPanningGesture: true,
      enableHandlePanningGesture: true,
      enablePanDownToClose: true,
      index: -1,
    })
  })
})
