import {render} from "@testing-library/react-native"

import {PhotoInfo} from "@/types/asg"

import {PhotoImage} from "./PhotoImage"

let mockImageProps: Record<string, unknown> = {}

jest.mock("expo-image", () => {
  const React = require("react")
  const {View} = require("react-native")
  return {
    Image: (props: Record<string, unknown>) => {
      mockImageProps = props
      return React.createElement(View, {testID: "gallery-thumbnail"})
    },
  }
})
jest.mock("react-native-shimmer-placeholder", () => {
  const React = require("react")
  const {View} = require("react-native")
  return {
    createShimmerPlaceholder: () => (props: Record<string, unknown>) => React.createElement(View, props),
  }
})
jest.mock("@/components/ignite", () => {
  const {Text} = require("react-native")
  return {Text}
})
jest.mock("@/contexts/ThemeContext", () => {
  const colors = {
    background: "white",
    border: "gray",
    primary: "blue",
    textDim: "gray",
    palette: {neutral200: "gray", primary500: "blue", secondary500: "purple"},
  }
  const spacing = {s2: 4, s3: 8}
  return {
    useAppTheme: () => ({
      theme: {colors},
      themed: (style: unknown) =>
        typeof style === "function"
          ? Reflect.apply(style, null, [{colors, spacing}])
          : style,
    }),
  }
})

describe("PhotoImage", () => {
  it("uses a downscaled, recyclable image view for gallery thumbnails", () => {
    const photo = {
      name: "photo.jpg",
      thumbnailPath: "file:///gallery/photo-thumb.jpg",
      is_video: false,
    } as PhotoInfo

    render(<PhotoImage photo={photo} style={{width: 120, height: 120}} />)

    expect(mockImageProps).toMatchObject({
      allowDownscaling: true,
      cachePolicy: "disk",
      contentFit: "cover",
      recyclingKey: photo.thumbnailPath,
      source: {uri: photo.thumbnailPath},
      transition: 0,
    })
  })
})
