// Tester page — exercises session.stream.
//
// Two flows:
//   - Unmanaged: caller-supplied RTMP/SRT/WHIP URL. Phone tells glasses to
//     publish directly. Zero cloud.
//   - Managed: phone hits /api/v2/client/streams/managed/provision; Cloudflare
//     mints an ingest URL + playback URLs (HLS/DASH/WHEP). Once HLS is ready
//     we embed Cloudflare's hosted player so you can see what the viewer sees.
//
// start*() resolve through the `tester:invoke` RPC reply (the awaited return
// of invoke()), so the start result is captured in local state. Status events
// from glasses publisher, Cloudflare poll, and the coordinator itself flow
// through the `stream_status` event channel as `kind:"status"`, so the timeline
// at the bottom shows everything in chronological order.

import {useMemo, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"
import {ErrorRow} from "./_TesterRow"

// Mirrors the SDK's StreamResult. Both direct and managed resolve to an object:
// direct gives {streamId, status}; managed additionally carries the Cloudflare
// playback fields. `hlsUrl` (managed-only) is the discriminator below.
interface StreamStartResult {
  streamId: string
  status?: string
  liveInputId?: string
  hlsUrl?: string
  dashUrl?: string
  webrtcUrl?: string
}

type StatusEvent = {
  streamId?: string
  status: string
  source?: string
  [k: string]: unknown
}

export default function StreamingPage() {
  const navigate = useNavigate()
  const {log, invoke, lastError} = useTester("stream")
  const [unmanagedUrl, setUnmanagedUrl] = useState("rtmp://")
  const [result, setResult] = useState<StreamStartResult | undefined>(undefined)

  const start = (options: Record<string, unknown>) => {
    invoke("startStream", [options])
      .then((r) => setResult(r as StreamStartResult))
      .catch(() => {
        /* error already surfaced via lastError → ErrorRow */
      })
  }
  const stop = () => {
    invoke("stop", [])
      .then(() => setResult(undefined))
      .catch(() => {
        /* error already surfaced via lastError → ErrorRow */
      })
  }

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

  // Managed start results carry Cloudflare playback URLs; unmanaged don't.
  const managed = result?.hlsUrl ? result : null

  // Cloudflare hosted-player iframe. The streamId we get back is phone-minted
  // (`phone-m-...`), so use the Cloudflare liveInputId surfaced explicitly on
  // the start result.
  const iframeSrc = useMemo(() => {
    if (!managed?.liveInputId) return null
    return `https://iframe.videodelivery.net/${encodeURIComponent(managed.liveInputId)}`
  }, [managed?.liveInputId])

  return (
    <Shell>
      <MiniappHeader title="session.stream" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Glasses-side RTMP/SRT/WHIP publishing. A direct URL publishes straight
          from the glasses; managed provisions a Cloudflare live input + playback URLs.
        </p>

        <Label htmlFor="stream-url">direct ingest URL</Label>
        <Input
          id="stream-url"
          value={unmanagedUrl}
          onChange={(e) => setUnmanagedUrl(e.target.value)}
          placeholder="rtmp://your.server/app/key"
        />
        <div className="mt-2 flex flex-col gap-2">
          <Button onClick={() => start({direct: unmanagedUrl})}>
            startStream(direct)
          </Button>
          <Button onClick={() => start({})}>startStream() (managed)</Button>
          <Button variant="destructive" onClick={stop}>
            stop()
          </Button>
        </div>

        {result && (
          <div className="mt-3 rounded-xl border border-border bg-muted/30 px-4 py-3 text-[12px]">
            <div className="font-semibold text-foreground">latest start result</div>
            <div className="mt-1 break-all font-mono text-muted-foreground">
              streamId: {result.streamId}
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

        {iframeSrc && (
          <div className="mt-3 overflow-hidden rounded-xl border border-border bg-black">
            <iframe
              src={iframeSrc}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              className="aspect-video w-full"
              title="Cloudflare WHEP viewer"
            />
          </div>
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

        <ErrorRow event={lastError} />
        <p className="mt-3 text-[12px] text-muted-foreground">
          {log.length} event(s) seen
        </p>
      </div>
    </Shell>
  )
}
