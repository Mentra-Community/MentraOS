import {act, fireEvent, render} from "@testing-library/react-native"
import {Modal, Platform} from "react-native"

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
jest.mock("./MediaMetadataSheet", () => ({
  MediaMetadataSheet: ({
    bottomSheetRef,
    onChange,
  }: {
    bottomSheetRef: {current: unknown}
    onChange: (index: number) => void
  }) => {
    const React = require("react")
    React.useImperativeHandle(
      bottomSheetRef,
      () => ({
        close: () => onChange(-1),
        snapToIndex: (index: number) => onChange(index),
      }),
      [onChange],
    )
    return null
  },
}))
jest.mock("react-native-awesome-gallery", () => {
  const React = require("react")
  const MockGallery = React.forwardRef((props: Record<string, unknown>, _ref: unknown) => {
    mockGalleryProps = props
    const data = props.data as unknown[]
    const index = props.initialIndex as number
    const renderItem = props.renderItem as jest.Mock
    return renderItem({item: data[index], index, setImageDimensions: jest.fn()})
  })
  MockGallery.displayName = "MockGallery"
  return {
    __esModule: true,
    default: MockGallery,
  }
})
jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => () => null)
jest.mock("react-native-video", () => () => null)

describe("CustomOverlay", () => {
  beforeEach(() => {
    mockGalleryProps = {}
    mockImageProps = {}
  })

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
    expect(getByText("share")).toBeTruthy()
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

    render(<AwesomeGalleryViewer visible photos={[photo]} initialIndex={0} onClose={jest.fn()} />)

    expect(mockGalleryProps).toMatchObject({pinchEnabled: true, doubleTapEnabled: true})
    expect(mockGalleryProps).not.toHaveProperty("onTranslationYChange")
    expect(mockGalleryProps).not.toHaveProperty("onPanStart")
  })

  it("uses viewport-sized image decoding on Android while preserving iOS full-resolution zoom", () => {
    const originalPlatform = Platform.OS
    const photo = {name: "photo.jpg", url: "file:///photo.jpg", is_video: false} as PhotoInfo

    try {
      Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
      render(<AwesomeGalleryViewer visible photos={[photo]} initialIndex={0} onClose={jest.fn()} />)
      expect(mockImageProps.allowDownscaling).toBe(true)

      Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
      render(<AwesomeGalleryViewer visible photos={[photo]} initialIndex={0} onClose={jest.fn()} />)
      expect(mockImageProps.allowDownscaling).toBe(false)
    } finally {
      Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
    }
  })

  it("removes the overlapping toolbar and closes details before closing the viewer", () => {
    const onClose = jest.fn()
    const photo = {name: "photo.jpg", url: "file:///photo.jpg", is_video: false} as PhotoInfo
    const {getByLabelText, queryByLabelText, UNSAFE_getByType} = render(
      <AwesomeGalleryViewer visible photos={[photo]} initialIndex={0} onClose={onClose} />,
    )

    fireEvent.press(getByLabelText("Show media details"))
    expect(queryByLabelText("Close media viewer")).toBeNull()

    act(() => UNSAFE_getByType(Modal).props.onRequestClose())
    expect(getByLabelText("Close media viewer")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    act(() => UNSAFE_getByType(Modal).props.onRequestClose())
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
