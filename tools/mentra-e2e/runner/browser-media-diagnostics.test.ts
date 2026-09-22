import {expect, test} from "bun:test"
import {chromium} from "playwright-core"
import {installMediaDiagnostics, sampleMediaDiagnostics} from "./browser-media-diagnostics"

// Optional Chrome integration check. Synthetic canvas pixels test the observer,
// never the Mentra Call routine. No hardware capture or meeting is involved.
test.skipIf(process.env.MENTRA_E2E_BROWSER_TEST !== "1")(
  "observe real loopback RTP without changing peer semantics",
  async () => {
    const browser = await chromium.launch({channel: "chrome", headless: true, chromiumSandbox: true})
    try {
      const context = await browser.newContext()
      await installMediaDiagnostics(context)
      const page = await context.newPage()
      await page.goto("about:blank")
      await page.evaluate(async () => {
        const sender = new RTCPeerConnection()
        const receiver = new RTCPeerConnection()
        if (!(sender instanceof RTCPeerConnection)) throw new Error("Peer constructor semantics changed")
        const canvas = document.createElement("canvas")
        canvas.width = 160
        canvas.height = 120
        const paint = canvas.getContext("2d")!
        let tick = 0
        setInterval(() => {
          paint.fillStyle = `hsl(${tick++ % 360} 100% 50%)`
          paint.fillRect(0, 0, 160, 120)
        }, 50)
        const stream = canvas.captureStream(10)
        sender.addTrack(stream.getVideoTracks()[0], stream)
        receiver.ontrack = ({streams}) => {
          const video = document.createElement("video")
          video.autoplay = true
          video.muted = true
          video.srcObject = streams[0]
          document.body.append(video)
        }
        const gather = (peer: RTCPeerConnection) =>
          new Promise<void>((resolve) => {
            if (peer.iceGatheringState === "complete") return resolve()
            peer.addEventListener("icegatheringstatechange", () => {
              if (peer.iceGatheringState === "complete") resolve()
            })
          })
        await sender.setLocalDescription(await sender.createOffer())
        await gather(sender)
        await receiver.setRemoteDescription(sender.localDescription!)
        await receiver.setLocalDescription(await receiver.createAnswer())
        await gather(receiver)
        await sender.setRemoteDescription(receiver.localDescription!)
      })
      const deadline = Date.now() + 15000
      let frames = await sampleMediaDiagnostics(page)
      const hasFrames = (type: string, key: string) =>
        frames.some((frame) => frame.peers?.some((p: any) => p.stats.some((s: any) => s.type === type && s[key] > 0)))
      while (!hasFrames("inbound-rtp", "framesDecoded") || !hasFrames("outbound-rtp", "framesEncoded")) {
        if (Date.now() > deadline) throw new Error("Loopback did not carry video")
        await Bun.sleep(100)
        frames = await sampleMediaDiagnostics(page)
      }
      const peers = frames[0].peers
      expect(peers).toHaveLength(2)
      expect(peers.every((p: any) => p.connectionState === "connected")).toBe(true)
      expect(
        peers.flatMap((p: any) => p.stats).some((s: any) => s.type === "outbound-rtp" && s.framesEncoded > 0),
      ).toBe(true)
      expect(JSON.stringify(frames)).not.toMatch(/ice-ufrag|candidate:|local-candidate|remote-candidate/)
    } finally {
      await browser.close()
    }
  },
  30000,
)
