import {render} from "@testing-library/react-native"

import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"
import {useDisplayStore} from "@/stores/display"

jest.mock("react-native-canvas", () => {
  const {createElement, forwardRef} = require("react")
  const {View} = require("react-native")
  const Canvas = forwardRef((props: any, ref: any) => createElement(View, {...props, ref}))
  Canvas.displayName = "MockCanvas"

  return {
    __esModule: true,
    default: Canvas,
    Image: jest.fn(),
  }
})

jest.mock("@/components/ignite", () => {
  const {createElement} = require("react")
  const {Text: RNText} = require("react-native")

  return {
    Text: ({children, text, ...props}: any) => createElement(RNText, props, text ?? children),
  }
})

jest.mock("@/contexts/ThemeContext", () => {
  const theme = {
    colors: {
      primary_foreground: "#000",
      text: "#fff",
      textDim: "#999",
    },
    spacing: {
      s2: 8,
      s3: 12,
      s4: 16,
    },
    typography: {
      fonts: {
        glassesMirror: {
          normal: "glassesMirror",
        },
      },
    },
  }

  return {
    useAppTheme: () => ({
      themed: (style: any) => (typeof style === "function" ? style(theme) : style),
    }),
  }
})

describe("GlassesDisplayMirror", () => {
  beforeEach(() => {
    useDisplayStore.setState({
      currentEvent: {},
      dashboardEvent: {},
      mainEvent: {},
      view: "main",
    })
  })

  it("renders clear_view as an empty mirror instead of an unknown layout error", () => {
    useDisplayStore.setState({
      currentEvent: {
        view: "main",
        layout: {layoutType: "clear_view"},
      },
    })

    const {queryByText, toJSON} = render(<GlassesDisplayMirror />)

    expect(queryByText(/Unknown layout type/i)).toBeNull()
    expect(toJSON()).toBeTruthy()
  })

  it("still renders text layouts", () => {
    useDisplayStore.setState({
      currentEvent: {
        view: "main",
        layout: {layoutType: "text_wall", text: "Hello mirror"},
      },
    })

    const {getByText} = render(<GlassesDisplayMirror />)

    expect(getByText("Hello mirror")).toBeTruthy()
  })
})
