import {act, fireEvent, render} from "@testing-library/react-native"
import {cloneElement} from "react"

import {PhotoInfo} from "@/types/asg"

import {AwesomeGalleryViewer, CustomOverlay} from "./AwesomeGalleryViewer"

let mockGalleryProps: Record<string, unknown> = {}
let mockImageProps: Record<string, unknown> = {}
let mockVideoProps: Record<string, unknown> = {}
let mockSliderProps: Record<string, unknown> = {}
const mockSeek = jest.fn()
const mockGetCurrentPosition = jest.fn()

jest.mock("@gorhom/bottom-sheet", () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock("@/components/ignite/Icon", () => {
  const React = require("react")
  const {Text} = require("react-native")
  return {Icon: ({name}: {name: string}) => React.createElement(Text, null, name)}
})
jest.mock("@/contexts/ThemeContext", () => {
  const theme = {
    colors: {background: "#f7f7f7", border: "#dddddd", foreground: "#111111"},
    spacing: {s2: 8, s3: 12, s4: 16, s6: 24, s8: 32},
  }

  return {
    useAppTheme: () => ({
      theme,
      themed: (style: unknown) => (typeof style === "function" ? style(theme) : style),
    }),
  }
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
jest.mock("react-native-video", () => {
  const React = require("react")
  return React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    React.useImperativeHandle(ref, () => ({seek: mockSeek, getCurrentPosition: mockGetCurrentPosition}))
    mockVideoProps = props
    return null
  })
})
jest.mock("@react-native-community/slider", () => (props: Record<string, unknown>) => {
  mockSliderProps = props
  return null
})

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

  it("uses the active theme background throughout video previews", () => {
    const video = {
      name: "video.mp4",
      url: "file:///gallery/video.mp4",
      thumbnailPath: "file:///gallery/video-thumbnail.jpg",
      is_video: true,
    } as PhotoInfo

    render(<AwesomeGalleryViewer visible photos={[video]} initialIndex={0} onClose={jest.fn()} />)
    const renderItem = mockGalleryProps.renderItem as (info: {
      item: PhotoInfo
      index: number
      setImageDimensions: jest.Mock
    }) => React.ReactElement

    const videoView = render(renderItem({item: video, index: 0, setImageDimensions: jest.fn()}))

    expect(videoView.getByTestId("video-player-container")).toHaveStyle({backgroundColor: "#f7f7f7"})
    expect(videoView.getByTestId("video-thumbnail-overlay")).toHaveStyle({backgroundColor: "#f7f7f7"})
    expect(mockVideoProps.style).toMatchObject({backgroundColor: "#f7f7f7"})
  })
})

describe("gallery video playback", () => {
  const duration = 600.4028930664062

  function emitVideo(event: string, payload: unknown = {}) {
    act(() => (mockVideoProps[event] as (payload: unknown) => void)(payload))
  }

  function finishVideo() {
    act(() => {
      const onProgress = mockVideoProps.onProgress as (payload: {currentTime: number}) => void
      const onEnd = mockVideoProps.onEnd as () => void
      onProgress({currentTime: duration})
      onEnd()
    })
  }

  function emitSlider(event: string, value = 0) {
    act(() => (mockSliderProps[event] as (value: number) => void)(value))
  }

  function renderVideo(load = true) {
    const photo = {name: "video.mp4", url: "file:///gallery/video.mp4", is_video: true} as PhotoInfo
    render(<AwesomeGalleryViewer visible photos={[photo]} initialIndex={0} onClose={jest.fn()} />)
    const renderItem = mockGalleryProps.renderItem as (info: {
      item: PhotoInfo
      index: number
      setImageDimensions: jest.Mock
    }) => React.ReactElement<{isActive: boolean}>
    const item = renderItem({item: photo, index: 0, setImageDimensions: jest.fn()})
    const view = render(item)
    if (load) emitVideo("onLoad", {duration})
    return {view, item}
  }

  beforeEach(() => {
    mockSeek.mockClear()
    mockGetCurrentPosition.mockReset().mockResolvedValue(NaN)
  })

  it("disables scrubbing until a finite duration is loaded", () => {
    renderVideo(false)
    expect(mockSliderProps.disabled).toBe(true)
    emitVideo("onLoad", {duration: Infinity})
    expect(mockSliderProps.disabled).toBe(true)
    expect(mockSliderProps.maximumValue).toBe(0)
    emitVideo("onLoad", {duration})
    expect(mockSliderProps.disabled).toBe(false)
  })

  it("pauses during scrubbing and seeks inside the file at the right endpoint", () => {
    renderVideo()
    emitSlider("onSlidingStart")
    expect(mockVideoProps.paused).toBe(true)
    expect(mockGalleryProps.swipeEnabled).toBe(false)
    emitVideo("onProgress", {currentTime: 100})
    expect(mockSliderProps.value).toBe(0)
    emitSlider("onSlidingComplete", duration)
    expect(mockSeek).toHaveBeenLastCalledWith(duration - 0.1)
    expect(mockSliderProps.value).toBe(duration - 0.1)
    expect(mockVideoProps.paused).toBe(false)
    expect(mockGalleryProps.swipeEnabled).toBe(true)
  })

  it("preserves playback intent if an old end event arrives while dragging", () => {
    renderVideo()
    emitSlider("onSlidingStart")
    finishVideo()
    emitSlider("onSlidingComplete", 30)
    expect(mockVideoProps.paused).toBe(false)
    expect(mockSeek).toHaveBeenLastCalledWith(30)
  })

  it("does not wait for an onSeek event after a same-position seek", async () => {
    mockGetCurrentPosition.mockResolvedValue(0)
    renderVideo()
    emitSlider("onSlidingStart")
    await act(async () => emitSlider("onSlidingComplete", 0))
    emitVideo("onProgress", {currentTime: 1})
    expect(mockSliderProps.value).toBe(1)
    expect(mockVideoProps.paused).toBe(false)
  })

  it("preserves a user pause when seeking near the end and resumes without replaying", () => {
    const {view} = renderVideo()
    fireEvent.press(view.getByText("pause"))
    emitSlider("onSlidingStart")
    emitSlider("onSlidingComplete", duration)
    emitVideo("onProgress", {currentTime: duration - 0.1})
    expect(mockVideoProps.paused).toBe(true)
    fireEvent.press(view.getByText("play"))
    expect(mockVideoProps.paused).toBe(false)
    expect(mockSeek).toHaveBeenCalledTimes(1)
  })

  it("stays stopped after end events and replays from zero", () => {
    const {view} = renderVideo()
    finishVideo()
    expect(mockSliderProps.value).toBe(duration)
    emitVideo("onProgress", {currentTime: duration - 1})
    expect(mockSliderProps.value).toBe(duration)
    expect(mockVideoProps.paused).toBe(true)
    fireEvent.press(view.getByText("replay"))
    expect(mockSeek).toHaveBeenLastCalledWith(0)
    expect(mockSliderProps.value).toBe(0)
    expect(mockVideoProps.paused).toBe(false)
  })

  it("accepts native completion when the final playhead is within a frame of duration", () => {
    const {view} = renderVideo()
    emitVideo("onProgress", {currentTime: duration - 0.033})
    emitVideo("onEnd")
    expect(mockVideoProps.paused).toBe(true)
    expect(view.getByText("replay")).toBeTruthy()
    expect(mockSliderProps.value).toBe(duration)
  })

  it("can seek backward after ending and play from the selected position", () => {
    const {view} = renderVideo()
    finishVideo()
    emitSlider("onSlidingStart")
    emitSlider("onSlidingComplete", 30)
    expect(mockVideoProps.paused).toBe(true)
    fireEvent.press(view.getByText("play"))
    expect(mockSeek).toHaveBeenCalledTimes(1)
    expect(mockSeek).toHaveBeenLastCalledWith(30)
    expect(mockVideoProps.paused).toBe(false)
  })

  it("ignores a late end event after seeking backward from completion", () => {
    const {view} = renderVideo()
    finishVideo()
    emitSlider("onSlidingStart")
    emitSlider("onSlidingComplete", 30)
    emitVideo("onEnd")
    expect(mockSliderProps.value).toBe(30)
    expect(view.queryByText("replay")).toBeNull()
    fireEvent.press(view.getByText("play"))
    expect(mockSeek).toHaveBeenCalledTimes(1)
    expect(mockSeek).toHaveBeenLastCalledWith(30)
    expect(mockVideoProps.paused).toBe(false)
  })

  it.each([false, true])("ignores queued final progress/end after a backward seek (paused=%s)", (paused) => {
    const {view} = renderVideo()
    emitVideo("onProgress", {currentTime: duration - 0.01})
    if (paused) fireEvent.press(view.getByText("pause"))
    emitSlider("onSlidingStart")
    emitSlider("onSlidingComplete", 30)
    finishVideo()
    expect(mockSliderProps.value).toBe(30)
    expect(view.queryByText("replay")).toBeNull()
    expect(mockVideoProps.paused).toBe(paused)
    emitVideo("onSeek", {currentTime: 30, seekTime: 30})
    emitVideo("onProgress", {currentTime: 30.25})
    expect(mockSliderProps.value).toBe(30.25)
    expect(mockVideoProps.paused).toBe(paused)
  })

  it("ignores queued final progress/end after replay and still completes the replay", () => {
    const {view} = renderVideo()
    finishVideo()
    fireEvent.press(view.getByText("replay"))
    finishVideo()
    expect(mockSliderProps.value).toBe(0)
    expect(mockVideoProps.paused).toBe(false)
    emitVideo("onSeek", {currentTime: 0, seekTime: 0})
    emitVideo("onProgress", {currentTime: 1})
    expect(mockSliderProps.value).toBe(1)
    finishVideo()
    expect(view.getByText("replay")).toBeTruthy()
  })

  it("settles from progress at the seek target when onSeek is absent", () => {
    renderVideo()
    emitSlider("onSlidingStart")
    emitSlider("onSlidingComplete", 30)
    finishVideo()
    emitVideo("onProgress", {currentTime: 30.001})
    emitVideo("onProgress", {currentTime: 30.25})
    expect(mockSliderProps.value).toBe(30.25)
    finishVideo()
    expect(mockVideoProps.paused).toBe(true)
  })

  it("accepts completion after a same-position near-end seek without onSeek", async () => {
    const {view} = renderVideo()
    const time = duration - 0.1
    emitVideo("onProgress", {currentTime: time})
    mockGetCurrentPosition.mockResolvedValue(time)
    emitSlider("onSlidingStart")
    await act(async () => emitSlider("onSlidingComplete", time))
    finishVideo()
    expect(view.getByText("replay")).toBeTruthy()
    expect(mockVideoProps.paused).toBe(true)
  })

  it("does not let an earlier seek callback or position read settle a newer seek", async () => {
    renderVideo()
    let resolveEarlier!: (position: number) => void
    mockGetCurrentPosition.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        resolveEarlier = resolve
      }),
    )
    emitSlider("onSlidingStart")
    emitSlider("onSlidingComplete", 30)
    emitSlider("onSlidingStart")
    emitSlider("onSlidingComplete", 60)
    await act(async () => resolveEarlier(30))
    emitVideo("onSeek", {currentTime: 30, seekTime: 30})
    emitVideo("onProgress", {currentTime: 30})
    finishVideo()
    expect(mockSliderProps.value).toBe(60)
    expect(mockVideoProps.paused).toBe(false)
    emitVideo("onSeek", {currentTime: 60, seekTime: 60})
    finishVideo()
    expect(mockVideoProps.paused).toBe(true)
  })

  it("ignores a late end event after replay starts", () => {
    const {view} = renderVideo()
    finishVideo()
    fireEvent.press(view.getByText("replay"))
    emitVideo("onEnd")
    expect(mockVideoProps.paused).toBe(false)
    expect(mockSliderProps.value).toBe(0)
    expect(view.queryByText("replay")).toBeNull()
  })

  it("restarts when returning to a video after swiping away", () => {
    const {view, item} = renderVideo()
    finishVideo()
    view.rerender(cloneElement(item, {isActive: false}))
    expect(mockVideoProps.paused).toBe(true)
    view.rerender(cloneElement(item, {isActive: true}))
    expect(mockSeek).toHaveBeenLastCalledWith(0)
    expect(mockVideoProps.paused).toBe(false)
    expect(view.queryByText("replay")).toBeNull()
  })

  it("does not let an inactive video's error unlock another video's scrub", () => {
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const {item} = renderVideo()
      const startActiveScrub = mockSliderProps.onSlidingStart as () => void
      render(cloneElement(item, {isActive: false}))
      const inactiveError = mockVideoProps.onError as (payload: unknown) => void
      act(() => startActiveScrub())
      expect(mockGalleryProps.swipeEnabled).toBe(false)
      act(() => inactiveError({error: {code: -11880}}))
      expect(mockGalleryProps.swipeEnabled).toBe(false)
    } finally {
      errorLog.mockRestore()
    }
  })

  it("keeps real decoder errors visible and does not resume on progress", () => {
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const {view} = renderVideo()
      emitSlider("onSlidingStart")
      emitVideo("onError", {error: {code: -11880, domain: "AVFoundationErrorDomain"}})
      emitVideo("onProgress", {currentTime: 1})
      expect(mockVideoProps.paused).toBe(true)
      expect(mockGalleryProps.swipeEnabled).toBe(true)
      expect(view.getByText("Playback Error")).toBeTruthy()
    } finally {
      errorLog.mockRestore()
    }
  })
})
