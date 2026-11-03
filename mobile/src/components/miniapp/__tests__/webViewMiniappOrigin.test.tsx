/**
 * The patched react-native-webview takes a `miniappOrigin` prop
 * (patches/react-native-webview@13.16.0.patch). These check that the prop
 * reaches the native view on both platforms; the native serving itself is
 * covered by scripts/test-webview-miniapp-origin*.sh.
 */
import {render} from "@testing-library/react-native"
import {readFileSync} from "fs"
import {join} from "path"
import type {ComponentType} from "react"
import type {WebViewProps} from "react-native-webview"

jest.unmock("react-native-webview")
// The WebView's TurboModule has no native side under Jest.
jest.mock("react-native-webview/lib/NativeRNCWebViewModule", () => ({
  __esModule: true,
  default: {isFileUploadSupported: jest.fn(async () => false), shouldStartLoadWithLockIdentifier: jest.fn()},
}))

type WebViewComponent = ComponentType<Record<string, unknown>>

// Typed through the public props, so the patched typings are checked too.
const origin: NonNullable<WebViewProps["miniappOrigin"]> = {
  packageName: "com.example.notes",
  rootDir: "/data/lmas/com.example.notes/1.0.0",
}

function nativeProps(WebView: WebViewComponent, props: Record<string, unknown>) {
  const screen = render(<WebView {...props} />)
  return screen.UNSAFE_getByType("RNCWebView" as never).props as Record<string, unknown>
}

describe("WebView miniappOrigin", () => {
  test("reaches the native view on iOS", () => {
    const {default: WebView} = jest.requireActual("react-native-webview/lib/WebView.ios") as {default: WebViewComponent}
    const props = nativeProps(WebView, {
      source: {uri: "miniapp://com.example.notes/ui/index.html"},
      originWhitelist: ["miniapp://com.example.notes"],
      miniappOrigin: origin,
    })
    expect(props.miniappOrigin).toEqual(origin)
    expect(props.allowingReadAccessToURL).toBeUndefined()
  })

  test("reaches the native view on Android", () => {
    const {default: WebView} = jest.requireActual("react-native-webview/lib/WebView.android") as {
      default: WebViewComponent
    }
    const props = nativeProps(WebView, {
      source: {uri: "https://com.example.notes.miniapp.invalid/ui/index.html"},
      originWhitelist: ["https://com.example.notes.miniapp.invalid"],
      miniappOrigin: origin,
    })
    expect(props.miniappOrigin).toEqual(origin)
    expect(props.allowFileAccess).toBe(false)
  })

  test("is left unset for other WebViews", () => {
    const {default: WebView} = jest.requireActual("react-native-webview/lib/WebView.ios") as {default: WebViewComponent}
    expect(nativeProps(WebView, {source: {uri: "https://example.com"}}).miniappOrigin).toBeUndefined()
  })

  test("is a native prop, so the Fabric view config keeps it", () => {
    // Metro builds the view config from this spec; a prop missing here never reaches native code.
    const spec = readFileSync(
      join(__dirname, "../../../../node_modules/react-native-webview/src/RNCWebViewNativeComponent.ts"),
      "utf8",
    )
    expect(spec).toMatch(/miniappOrigin\?: Readonly<\{\s*packageName: string;\s*rootDir: string;\s*\}>/)
  })
})
