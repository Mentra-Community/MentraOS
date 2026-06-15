// Minimal WHEP (WebRTC-HTTP Egress Protocol) viewer for sub-second live
// playback of a WHIP-ingested stream. Cloudflare's hosted iframe player is
// HLS-only, so the WebRTC mode needs its own client: POST an SDP offer to the
// WHEP endpoint, apply the answer, attach the remote tracks to a <video>.

import {useEffect, useRef, useState} from "react"

export function WhepPlayer({url}: {url: string}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [state, setState] = useState<"connecting" | "playing" | "error">("connecting")
  const [detail, setDetail] = useState<string>("")

  useEffect(() => {
    let cancelled = false
    const pc = new RTCPeerConnection()
    pc.addTransceiver("video", {direction: "recvonly"})
    pc.addTransceiver("audio", {direction: "recvonly"})
    // Video and audio arrive as separate ontrack events — accumulate into ONE
    // MediaStream. Assigning ev.streams[0] per event lets the later track's
    // stream clobber the earlier one (black video with working audio).
    const media = new MediaStream()
    pc.ontrack = (ev) => {
      if (cancelled || !videoRef.current) return
      media.addTrack(ev.track)
      if (videoRef.current.srcObject !== media) {
        videoRef.current.srcObject = media
      }
    }
    pc.onconnectionstatechange = () => {
      if (cancelled) return
      if (pc.connectionState === "connected") setState("playing")
      if (pc.connectionState === "failed") {
        setState("error")
        setDetail("peer connection failed")
      }
    }

    const connect = async () => {
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        // Wait for ICE gathering so the offer carries all candidates —
        // WHEP is a single round trip, no trickle.
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === "complete") return resolve()
          const check = () => {
            if (pc.iceGatheringState === "complete") {
              pc.removeEventListener("icegatheringstatechange", check)
              resolve()
            }
          }
          pc.addEventListener("icegatheringstatechange", check)
        })
        const res = await fetch(url, {
          method: "POST",
          headers: {"Content-Type": "application/sdp"},
          body: pc.localDescription!.sdp,
        })
        if (!res.ok) throw new Error(`WHEP endpoint returned ${res.status}`)
        const answer = await res.text()
        if (cancelled) return
        await pc.setRemoteDescription({type: "answer", sdp: answer})
      } catch (err) {
        if (cancelled) return
        setState("error")
        setDetail(err instanceof Error ? err.message : String(err))
      }
    }
    void connect()

    return () => {
      cancelled = true
      pc.close()
    }
  }, [url])

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-black">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} autoPlay playsInline muted className="aspect-video w-full" />
      <div className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        {state === "playing" ? "● live · WebRTC (sub-second)" : state === "error" ? `WHEP error: ${detail}` : "connecting WHEP…"}
      </div>
    </div>
  )
}
