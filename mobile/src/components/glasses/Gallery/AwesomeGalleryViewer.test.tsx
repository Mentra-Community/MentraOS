import {fireEvent, render} from "@testing-library/react-native"

import {PhotoInfo} from "@/types/asg"

import {AwesomeGalleryViewer, CustomOverlay} from "./AwesomeGalleryViewer"

let mockGalleryProps: Record<string, unknown> = {}
let mockImageProps: Record<string, unknown> = {}

jest.mock("@gorhom/bottom-sheet", () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock("@/components/ignite/Icon", () => {
  const React = require("react")
  const {Text} = require("react-native")
  return {Icon: ({name}: {name: string}) => React.createElement(Text, null, name)}
})
jest.mock("expo-image", () => ({
  Image: (props: Record<string, unknown>) => {
    mockImageProps = props
    return null
  },
}))
jest.mock("./MediaMetadataSheet", () => ({MediaMetadataSheet: () => null}))
jest.mock("react-native-gesture-handler", () => {
  const React = require("react")
  const {View} = require("react-native")
  return {
    GestureHandlerRootView: ({children, ...props}: {children: React.ReactNode}) =>
      React.createElement(View, props, children),
  }
})
jest.mock("react-native-awesome-gallery", () => {
  const React = require("react")
  const MockGallery = React.forwardRef((props: Record<string, unknown>, _ref: unknown) => {
    mockGalleryProps = props
    return null
  })
  MockGallery.displayName = "MockGallery"
  return {
    __esModule: true,
    default: MockGallery,
  }
})
jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => {
  const React = require("react")
  const {Text} = require("react-native")
  return function MockMaterialCommunityIcon({name}: {name: string}) {
    return React.createElement(Text, null, name)
  }
})
jest.mock("react-native-video", () => () => null)

describe("CustomOverlay", () => {
  it("exposes visible toolbar actions for closing, details, and sharing", () => {
    const onClose = jest.fn()
    const onDetails = jest.fn()
    const onShare = jest.fn()
    const {getByLabelText, getByText} = render(
      <CustomOverlay currentIndex={2} total={8} onClose={onClose} onDetails={onDetails} onShare={onShare} />,
    )

    expect(getByText("3 / 8")).toBeTruthy()
    expect(getByText("chevron-left")).toBeTruthy()
    expect(getByText("info")).toBeTruthy()
    expect(getByText("share-variant")).toBeTruthy()
    fireEvent.press(getByLabelText("Close media viewer"))
    fireEvent.press(getByLabelText("Show media details"))
    fireEvent.press(getByLabelText("Share media"))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onDetails).toHaveBeenCalledTimes(1)
    expect(onShare).toHaveBeenCalledTimes(1)
  })

  it("keeps details available when sharing is unavailable", () => {
    const {getByLabelText, queryByLabelText} = render(
      <CustomOverlay currentIndex={0} total={1} onClose={jest.fn()} onDetails={jest.fn()} />,
    )

    expect(getByLabelText("Show media details")).toBeTruthy()
    expect(queryByLabelText("Share media")).toBeNull()
  })

  it("keeps pinch zoom enabled without observing vertical translation for metadata", () => {
    const photo = {name: "photo.jpg", url: "file:///photo.jpg", is_video: false} as PhotoInfo

    const onClose = jest.fn()
    const view = render(<AwesomeGalleryViewer visible photos={[photo]} initialIndex={0} onClose={onClose} />)
    const firstIndexChange = mockGalleryProps.onIndexChange
    const firstSwipeToClose = mockGalleryProps.onSwipeToClose

    view.rerender(<AwesomeGalleryViewer visible photos={[photo]} initialIndex={0} onClose={onClose} />)

    expect(mockGalleryProps).toMatchObject({pinchEnabled: true, doubleTapEnabled: true})
    expect(mockGalleryProps).not.toHaveProperty("onTranslationYChange")
    expect(mockGalleryProps).not.toHaveProperty("onPanStart")
    expect(mockGalleryProps.onIndexChange).toBe(firstIndexChange)
    expect(mockGalleryProps.onSwipeToClose).toBe(firstSwipeToClose)
    expect(view.getByTestId("media-viewer-gesture-root")).toBeTruthy()
  })

  it("downscales local images before caching them on Android", () => {
    const photo = {name: "photo.jpg", filePath: "/gallery/photo.jpg", is_video: false} as PhotoInfo

    render(<AwesomeGalleryViewer visible photos={[photo]} initialIndex={0} onClose={jest.fn()} />)
    const renderItem = mockGalleryProps.renderItem as (info: {
      item: PhotoInfo
      index: number
      setImageDimensions: jest.Mock
    }) => React.ReactElement

    render(renderItem({item: photo, index: 0, setImageDimensions: jest.fn()}))

    expect(mockImageProps).toMatchObject({
      allowDownscaling: true,
      priority: "high",
      source: {uri: "file:///gallery/photo.jpg"},
      transition: 0,
    })
  })
})
