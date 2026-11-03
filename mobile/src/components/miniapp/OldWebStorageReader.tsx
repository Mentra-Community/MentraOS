import {useCallback, useEffect, useRef, useState, type ReactNode} from "react"
import {View} from "react-native"
import {WebView, type WebViewMessageEvent, type WebViewProps} from "react-native-webview"

import {
  parseWebStorageRead,
  removeWebStorageReader,
  writeWebStorageReader,
  type WebStorageMove,
  type WebStorageRead,
} from "@/services/miniapps/webStorageMigration"
import {BgTimer} from "@mentra/engine"

/** How long the hidden page has to read the old store before this open goes ahead without it. */
export const OLD_WEB_STORAGE_READ_TIMEOUT_MS = 5000

interface ReaderPage {
  move: WebStorageMove
  pageUri: string
  directoryUri: string
}

const HIDDEN = {position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden"} as const

/**
 * The hidden page that reads a package's old `file://` web storage for its
 * move (see `webStorageMigration.ts`). `read(move)` mounts it, resolves with
 * what it read, an error, or a timeout, and removes it again. Render `reader`
 * somewhere in the screen's tree.
 *
 * It is the only page that loads with file access, and it only ever loads the
 * host's own reader page from its own directory.
 */
export function useOldWebStorageReader(): {
  reader: ReactNode
  read: (move: WebStorageMove) => Promise<WebStorageRead>
  cancel: () => void
} {
  const [page, setPage] = useState<ReaderPage | null>(null)
  const finishRef = useRef<((result: WebStorageRead) => void) | null>(null)

  const cancel = useCallback(() => {
    finishRef.current?.({error: "the screen closed before the read finished"})
  }, [])
  useEffect(() => cancel, [cancel])

  const read = useCallback((move: WebStorageMove) => {
    finishRef.current?.({error: "another read started"})
    return new Promise<WebStorageRead>((resolve) => {
      let written: {pageUri: string; directoryUri: string}
      try {
        written = writeWebStorageReader(move)
      } catch (error) {
        resolve({error: `writing the reader page failed: ${error instanceof Error ? error.message : String(error)}`})
        return
      }
      let done = false
      const finish = (result: WebStorageRead) => {
        if (done) return
        done = true
        BgTimer.clearTimeout(timer)
        if (finishRef.current === finish) finishRef.current = null
        setPage((current) => (current?.move === move ? null : current))
        removeWebStorageReader(move)
        resolve(result)
      }
      const timer = BgTimer.setTimeout(
        () => finish({error: `the reader page didn't answer within ${OLD_WEB_STORAGE_READ_TIMEOUT_MS}ms`}),
        OLD_WEB_STORAGE_READ_TIMEOUT_MS,
      )
      finishRef.current = finish
      setPage({move, ...written})
    })
  }, [])

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!page) return
      const result = parseWebStorageRead(event.nativeEvent.data, page.move)
      if (result) finishRef.current?.(result)
    },
    [page],
  )

  const handleError = useCallback<NonNullable<WebViewProps["onError"]>>((event) => {
    finishRef.current?.({error: `the reader page didn't load (${event.nativeEvent.code})`})
  }, [])

  const reader = page ? (
    <View pointerEvents="none" style={HIDDEN} testID="old-web-storage-reader">
      <WebView
        source={{uri: page.pageUri}}
        // The old store is the one every file:// page shared, so the page loads
        // with the file settings those pages had. It loads nothing else.
        originWhitelist={["file://*"]}
        onShouldStartLoadWithRequest={({url}) => url.startsWith("file://") || url === "about:blank"}
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowingReadAccessToURL={page.directoryUri}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        onMessage={handleMessage}
        onError={handleError}
        style={{width: 1, height: 1}}
      />
    </View>
  ) : null

  return {reader, read, cancel}
}
