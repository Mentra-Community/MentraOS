// Tester page — exercises session.stream.
//
// Two flows:
//   - Unmanaged: caller-supplied RTMP/SRT/WHIP URL. Phone tells glasses to
//     publish directly. Zero cloud.
//   - Managed: phone hits /api/v2/client/streams/managed/provision; Cloudflare
//     mints an ingest URL + playback URLs (HLS/DASH/WHEP). Once HLS is ready
//     we embed Cloudflare's hosted player so you can see what the viewer sees.
//
// Status events from glasses publisher, Cloudflare poll, and the coordinator
// itself all flow through the same `stream_status` event channel, so the
// timeline at the bottom shows everything in chronological order.

import {useMemo, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"
import {ErrorRow, StatusRow} from "./_TesterRow"
import {WhepPlayer} from "./_WhepPlayer"

interface ManagedStartResult {
  streamId: string
  liveInputId: string
  /** "hls" (SRT ingest: HLS player, ~10-20s) or "webrtc" (WHIP ingest: WHEP player, <1s). */
  mode?: "hls" | "webrtc"
  hlsUrl: string
  dashUrl: string
  webrtcUrl?: string
}

// SDK returns a bare string (the streamId) from startUnmanaged(). Modeling it
// explicitly so the type guard below — `typeof result === "string"` vs object
// shape — is exhaustive.
type StartResult = string | ManagedStartResult

type StatusEvent = {
  streamId?: string
  status: string
  source?: string
  [k: string]: unknown
}

export default function StreamingPage() {
  const navigate = useNavigate()
  const {latestByKind, log, invoke, lastError, status} = useTester("stream")
  const [unmanagedUrl, setUnmanagedUrl] = useState("rtmp://")
  // The start result comes back as the RPC's resolved value — capture it in
  // state so the playback card + live player render. (The event channel only
  // carries controller-driven fires, not tester:invoke results.)
  const [startResult, setStartResult] = useState<StartResult | null>(null)

  const start = (method: "startUnmanaged" | "startManaged", args: unknown[]) => {
    void invoke(method, args)
      .then((r) => setStartResult(r as StartResult))
      .catch(() => {}) // StatusRow renders the structured failure
  }
  const stop = () => {
    void invoke("stop", [])
      .then(() => setStartResult(null))
      .catch(() => {})
  }

  const lastResultEvent = latestByKind("result")
  const eventResult: StartResult | undefined = lastResultEvent
    ? ((lastResultEvent.payload as {result?: unknown}).result as StartResult | undefined)
    : undefined
  const result: StartResult | undefined = startResult ?? eventResult

  // Status events, newest first, capped for sanity.
  const statusEvents = useMemo(
    () =>
      log
        .filter((e) => e.kind === "status")
        .slice(-20)
        .reverse()
        .map((e) => e.payload as StatusEvent),
    [log],
  )

  // Distinguish the two shapes: unmanaged returns a bare streamId string,
  // managed returns a {streamId, liveInputId, hlsUrl, ...} object.
  const managed: ManagedStartResult | null =
    result && typeof result === "object" && "hlsUrl" in result ? result : null
  const unmanagedStreamId: string | null = typeof result === "string" ? result : null

  // Cloudflare hosted-player iframe. The streamId we get back is phone-minted
  // (`phone-m-...`), so use the Cloudflare liveInputId surfaced explicitly on
  // the start result. LIVE inputs embed via the account's customer subdomain
  // (derive it from the WHEP playback URL, which carries that host) —
  // iframe.videodelivery.net only resolves VOD uids reliably. autoplay+muted
  // so the WebView starts playback without a user gesture.
  const iframeSrc = useMemo(() => {
    if (!managed?.liveInputId) return null
    const uid = encodeURIComponent(managed.liveInputId)
    if (managed.webrtcUrl) {
      try {
        const host = new URL(managed.webrtcUrl).origin
        return `${host}/${uid}/iframe?autoplay=true&muted=true`
      } catch {
        /* fall through to the shared host */
      }
    }
    return `https://iframe.videodelivery.net/${uid}?autoplay=true&muted=true`
  }, [managed?.liveInputId, managed?.webrtcUrl])

  return (
    <Shell>
      <MiniappHeader title="session.stream" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Glasses-side RTMP/SRT/WHIP publishing. Unmanaged uses your URL
          directly; managed provisions a Cloudflare live input + playback URLs.
        </p>

        <Label htmlFor="stream-url">unmanaged ingest URL</Label>
        <Input
          id="stream-url"
          value={unmanagedUrl}
          onChange={(e) => setUnmanagedUrl(e.target.value)}
          placeholder="rtmp://your.server/app/key"
        />
        <div className="mt-2 flex flex-col gap-2">
          <Button onClick={() => start("startUnmanaged", [{streamUrl: unmanagedUrl}])}>
            startUnmanaged(streamUrl)
          </Button>
          <Button onClick={() => start("startManaged", [{}])}>
            startManaged() — SRT → HLS (~15s delay, recorded)
          </Button>
          <Button onClick={() => start("startManaged", [{ingest: "whip"}])}>
            startManaged(whip) — WebRTC (&lt;1s, live monitor)
          </Button>
          <Button variant="destructive" onClick={stop}>
            stop()
          </Button>
        </div>

        {result && (
          <div className="mt-3 rounded-xl border border-border bg-muted/30 px-4 py-3 text-[12px]">
            <div className="font-semibold text-foreground">latest start result</div>
            <div className="mt-1 break-all font-mono text-muted-foreground">
              streamId: {managed?.streamId ?? unmanagedStreamId}
            </div>
            {managed?.hlsUrl && (
              <div className="mt-1 break-all font-mono text-muted-foreground">
                hlsUrl: {managed.hlsUrl}
              </div>
            )}
            {managed?.webrtcUrl && (
              <div className="mt-1 break-all font-mono text-muted-foreground">
                webrtcUrl: {managed.webrtcUrl}
              </div>
            )}
          </div>
        )}

        {managed?.mode === "webrtc" && managed.webrtcUrl ? (
          <div className="mt-3">
            <WhepPlayer url={managed.webrtcUrl} />
          </div>
        ) : (
          iframeSrc && (
            <div className="mt-3 overflow-hidden rounded-xl border border-border bg-black">
              <iframe
                src={iframeSrc}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                className="aspect-video w-full"
                title="Cloudflare live player (LL-HLS)"
              />
            </div>
          )
        )}

        <div className="mt-4 rounded-xl border border-border">
          <div className="border-b border-border px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            status timeline
          </div>
          {statusEvents.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-muted-foreground">
              (no status events yet)
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {statusEvents.map((ev, i) => (
                <li key={i} className="px-3 py-2 font-mono text-[12px]">
                  <span className="text-mentra-green">{ev.source ?? "?"}</span>{" "}
                  <span className="text-foreground">{ev.status}</span>
                  {ev.streamId && (
                    <span className="ml-2 text-muted-foreground">{String(ev.streamId)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <StatusRow status={status} />
        <ErrorRow event={lastError} />
        <p className="mt-3 text-[12px] text-muted-foreground">
          {log.length} event(s) seen
        </p>
      </div>
    </Shell>
  )
}
