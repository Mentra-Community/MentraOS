import {render} from "@testing-library/react-native"

import {engine} from "@mentra/engine"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"
import {useDisplayStore} from "@mentra/engine/internal"

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
    // The mirror reads through engine.display.mirror now; delegate the mocked
    // facade to the real display store this test seeds via setState().
    ;(engine.display.mirror.current as jest.Mock).mockImplementation(() => useDisplayStore.getState().currentEvent)
    ;(engine.display.mirror.onMirror as jest.Mock).mockImplementation((cb: (event: unknown) => void) =>
      useDisplayStore.subscribe((s) => s.currentEvent, cb),
    )
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

  it("renders positioned text from scene frames", () => {
    useDisplayStore.setState({
      currentEvent: {
        view: "main",
        layout: {
          layoutType: "scene",
          width: 576,
          height: 288,
          elements: [
            {
              id: "title",
              type: "text",
              box: {x: 12, y: 20, w: 300, h: 50},
              text: "Scene mirror text",
              change: "created",
              contentHash: "hash",
            },
            {
              id: "outline",
              type: "rect",
              box: {x: 0, y: 0, w: 576, h: 288},
              style: {border: 2, radius: 4},
              change: "created",
              contentHash: "rect-hash",
            },
          ],
        },
      },
    })

    const {getByText, queryByText} = render(<GlassesDisplayMirror />)

    expect(getByText("Scene mirror text")).toBeTruthy()
    expect(queryByText(/Unknown layout type/i)).toBeNull()
  })
})
