import {registerMiniapp} from "@mentra/miniapp/background"

interface ProbeHandle {
  handleId: string
  stop(): Promise<void>
}

type PreviewFn = (options: {source: "call"}) => Promise<ProbeHandle>

/**
 * Asks for the call stream preview while another miniapp (Mentra Call) owns the meeting. The host
 * must refuse with `not_meeting_owner`; the UI shows whatever came back so the Maestro flow can
 * assert on it. A grant would be a bug, so it is released at once and reported as `granted`.
 */
registerMiniapp((session) => {
  const ui = session.ui as unknown as {
    handle: (channel: "probe:preview", handler: () => Promise<{result: string}>) => void
  }

  ui.handle("probe:preview", async () => {
    const preview = (session.stream as unknown as {preview?: PreviewFn}).preview
    if (typeof preview !== "function") return {result: "sdk_without_preview"}
    try {
      const handle = await preview.call(session.stream, {source: "call"})
      console.warn(`[preview-probe] granted a preview it does not own: handleId=${handle.handleId}`)
      await handle.stop().catch(() => {})
      return {result: "granted"}
    } catch (error) {
      const code = (error as {code?: unknown})?.code
      const result = typeof code === "string" ? code : String(error)
      console.log(`[preview-probe] preview refused: ${result}`)
      return {result}
    }
  })
})
