import {decideMiniappNavigation, miniappOriginWhitelist} from "@/components/miniapp/miniappNavigation"

const IOS = "miniapp://com.mentra.notes"
const ANDROID = "https://com.mentra.notes.miniapp.invalid"

describe("miniappOriginWhitelist", () => {
  it("names the page's origin and the schemes frames and links use, never a wildcard or files", () => {
    const whitelist = miniappOriginWhitelist(IOS)
    expect(whitelist[0]).toBe(IOS)
    expect(whitelist).not.toContain("*")
    // No other package's origin: those get the library's fallback, which opens nothing for miniapp:.
    expect(whitelist.slice(1).some((entry) => entry.startsWith("file") || entry.startsWith("miniapp"))).toBe(false)
  })
})

describe("decideMiniappNavigation", () => {
  it.each([IOS, ANDROID])("keeps the top frame on %s", (origin) => {
    expect(decideMiniappNavigation({url: `${origin}/ui/index.html`, isTopFrame: true}, origin)).toBe("load")
    expect(decideMiniappNavigation({url: `${origin}/ui/index.html#/notes`}, origin)).toBe("load")
    expect(decideMiniappNavigation({url: origin, isTopFrame: true}, origin)).toBe("load")
    expect(decideMiniappNavigation({url: "about:blank", isTopFrame: true}, origin)).toBe("load")
    expect(decideMiniappNavigation({url: `blob:${origin}/5b1c`, isTopFrame: true}, origin)).toBe("load")
  })

  it("matches a miniapp: host exactly and an http(s) host in any case", () => {
    expect(decideMiniappNavigation({url: "miniapp://COM.MENTRA.NOTES/ui/index.html", isTopFrame: true}, IOS)).toBe(
      "refuse",
    )
    expect(
      decideMiniappNavigation(
        {url: "https://COM.MENTRA.NOTES.miniapp.invalid/ui/index.html", isTopFrame: true},
        ANDROID,
      ),
    ).toBe("load")
  })

  it("refuses another package's origin, including one that only shares a prefix", () => {
    expect(decideMiniappNavigation({url: "miniapp://com.mentra.notesx/ui/index.html", isTopFrame: true}, IOS)).toBe(
      "refuse",
    )
    expect(decideMiniappNavigation({url: "miniapp://com.mentra.call/ui/index.html", isTopFrame: false}, IOS)).toBe(
      "refuse",
    )
    for (const isTopFrame of [true, false, undefined]) {
      expect(
        decideMiniappNavigation({url: "https://com.mentra.call.miniapp.invalid/ui/index.html", isTopFrame}, ANDROID),
      ).toBe("refuse")
    }
  })

  it("never loads a file or content URL in any frame", () => {
    for (const isTopFrame of [true, false, undefined]) {
      expect(decideMiniappNavigation({url: "file:///etc/hosts", isTopFrame}, IOS)).toBe("refuse")
      expect(decideMiniappNavigation({url: "content://media/1", isTopFrame}, ANDROID)).toBe("refuse")
    }
  })

  it("lets frames show web content: stream players, srcdoc maps, blobs", () => {
    for (const url of [
      "https://customer-x.cloudflarestream.com/abc/iframe",
      "about:srcdoc",
      "about:blank",
      "blob:https://player.example/1",
      "data:text/html,hi",
    ]) {
      expect(decideMiniappNavigation({url, isTopFrame: false}, IOS)).toBe("load")
    }
    expect(decideMiniappNavigation({url: "com.mentra://applet/local", isTopFrame: false}, IOS)).toBe("refuse")
  })

  it("hands a top-level link elsewhere to the system browser and refuses other schemes", () => {
    expect(decideMiniappNavigation({url: "https://example.com/", isTopFrame: true}, IOS)).toBe("open_externally")
    expect(decideMiniappNavigation({url: "http://example.com/"}, ANDROID)).toBe("open_externally")
    expect(decideMiniappNavigation({url: "mailto:ada@example.com", isTopFrame: true}, IOS)).toBe("open_externally")
    expect(decideMiniappNavigation({url: "data:text/html,hi", isTopFrame: true}, IOS)).toBe("refuse")
    expect(decideMiniappNavigation({url: "blob:https://elsewhere.example/1", isTopFrame: true}, IOS)).toBe("refuse")
    expect(decideMiniappNavigation({url: "intent://scan#Intent;end", isTopFrame: true}, ANDROID)).toBe("refuse")
  })

  it("keeps a development build on its server", () => {
    const dev = "http://192.168.1.20:8081"
    expect(decideMiniappNavigation({url: `${dev}/dist/ui/index.html`, isTopFrame: true}, dev)).toBe("load")
    expect(decideMiniappNavigation({url: "http://192.168.1.20:8082/", isTopFrame: true}, dev)).toBe("open_externally")
  })
})

describe("the Mentra App's own links", () => {
  const ownLinks = [
    "com.mentra://open?url=https%3A%2F%2Fnotes.example.com%2F",
    "com.mentra://test/load-miniapp?package=com.mentra.notes&version=1.0.0&url=https%3A%2F%2Fx%2Fb.zip",
    "com.mentra://auth/callback?code=x&state=y",
    "com.mentra.mentra://home",
    "msauth://com.mentra.mentra/hash?code=x",
    "https://apps.mentraglass.com/open?url=https%3A%2F%2Fnotes.example.com%2F",
    "https://apps.mentraglass.com/package/com.example.notes",
    "https://apps.mentra.glass/auth/reset-password#access_token=x&refresh_token=y&type=recovery",
    "intent://open?url=https%3A%2F%2Fnotes.example.com%2F#Intent;scheme=com.mentra;package=com.mentra.mentra;end",
  ]

  it.each(ownLinks)("a miniapp's screen never opens %s, in any frame", (url) => {
    for (const isTopFrame of [true, false, undefined]) {
      const decision = decideMiniappNavigation({url, isTopFrame}, IOS)
      // An app-link host may show as a web page inside a frame; it is never handed to the system.
      expect(decision).not.toBe("open_externally")
      if (!url.startsWith("https://") || isTopFrame !== false) expect(decision).toBe("refuse")
    }
  })

  it.each(ownLinks)("the WebView asks the host about %s rather than handing it to the system", (url) => {
    // react-native-webview hands a URL outside `originWhitelist` straight to Linking, never asking the host.
    jest.isolateModules(() => {
      const Linking = {canOpenURL: jest.fn(async () => true), openURL: jest.fn(async () => true)}
      jest.doMock("react-native", () => ({
        Linking,
        Platform: {OS: "android"},
        StyleSheet: {create: (s: unknown) => s},
        View: "View",
        Text: "Text",
        ActivityIndicator: "ActivityIndicator",
      }))
      const {createOnShouldStartLoadWithRequest} = require("react-native-webview/lib/WebViewShared")
      const loadRequest = jest.fn()
      const decide = jest.fn(
        (request: {url: string; isTopFrame?: boolean}) => decideMiniappNavigation(request, ANDROID) === "load",
      )
      createOnShouldStartLoadWithRequest(
        loadRequest,
        miniappOriginWhitelist(ANDROID),
        decide,
      )({
        nativeEvent: {url, isTopFrame: true, lockIdentifier: 1},
      })
      expect(decide).toHaveBeenCalled()
      expect(Linking.canOpenURL).not.toHaveBeenCalled()
      expect(Linking.openURL).not.toHaveBeenCalled()
      expect(loadRequest).toHaveBeenCalledWith(false, url, 1)
    })
  })

  it("still opens other web links in the system browser", () => {
    expect(decideMiniappNavigation({url: "https://docs.mentraglass.com/", isTopFrame: true}, IOS)).toBe(
      "open_externally",
    )
  })
})
