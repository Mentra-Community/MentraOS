// Tester page — exercises session.camera via the `tester:invoke` RPC.
// takePhoto() and warmUp() resolve through the RPC reply (the awaited return
// value of invoke()), NOT a streamed tester:event — so capture results live
// in local state.

import {useEffect, useRef, useState} from "react"
import {useNavigate} from "react-router-dom"
import type {DownloadResult} from "@mentra/miniapp"
import {MiniappHeader} from "@mentra/miniapp/ui"

import type {TesterEventPayload} from "../../shared/types"
import {useChannel} from "../../hooks/useChannel"
import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "../../components/select"
import {Spinner} from "../../components/spinner"
import {Switch} from "../../components/switch"
import {ErrorRow, TableRow} from "./_TesterRow"
import {
  buildTakePhotoArgs,
  buildWarmUpArgs,
  CANONICAL_PHOTO_SIZES,
  DEFAULT_WARMUP_DURATION_MS,
  formatByteSize,
  formatElapsedMs,
  type PhotoMode,
  type PhotoSize,
  type PhotoTakenResult,
  type TakePhotoConfig,
} from "./cameraPageModel"

function imageExtension(mimeType?: string): string {
  switch (mimeType?.toLowerCase()) {
    case "image/avif":
      return "avif"
    case "image/png":
      return "png"
    case "image/webp":
      return "webp"
    default:
      return "jpg"
  }
}

export default function CameraPage() {
  const navigate = useNavigate()
  const {invoke, lastError} = useTester("camera")
  const {invoke: invokeSystem} = useTester("system")
  // Subscribing to the input tester keeps session.input.onButtonPress open
  // only while this page is mounted.
  const {latest: latestInputEvent} = useTester("input")
  const snapshot = useChannel("captions:snapshot")
  const capabilities = snapshot?.capabilities

  const [result, setResult] = useState<PhotoTakenResult | undefined>(undefined)
  const [size, setSize] = useState<PhotoSize>("medium")
  const [mode, setMode] = useState<PhotoMode>("photo")
  const [zsl, setZsl] = useState(true)
  const [mfnr, setMfnr] = useState(true)
  const [durationMs, setDurationMs] = useState(String(DEFAULT_WARMUP_DURATION_MS))
  const [capturePending, setCapturePending] = useState(false)
  const [warmupPending, setWarmupPending] = useState(false)
  const [warmupStatus, setWarmupStatus] = useState<string | null>(null)
  const [captureElapsedMs, setCaptureElapsedMs] = useState<number | undefined>(undefined)
  const [warmupElapsedMs, setWarmupElapsedMs] = useState<number | undefined>(undefined)
  const [isSharing, setIsSharing] = useState(false)
  const [shareError, setShareError] = useState<TesterEventPayload | null>(null)
  const sharingRef = useRef(false)

  const parsedDurationMs = Number.parseInt(durationMs, 10)
  const warmupDurationMs =
    Number.isFinite(parsedDurationMs) && parsedDurationMs > 0 ? parsedDurationMs : DEFAULT_WARMUP_DURATION_MS
  const busy = capturePending || warmupPending || isSharing
  const config: TakePhotoConfig = {
    size,
    mode,
    zsl,
    mfnr,
  }

  const captureWithConfig = async (captureConfig: TakePhotoConfig) => {
    const startedAt = performance.now()
    const photo = (await invoke("takePhoto", [...buildTakePhotoArgs(captureConfig)])) as PhotoTakenResult
    setResult(photo)
    setCaptureElapsedMs(performance.now() - startedAt)
  }

  const takePhoto = async () => {
    setShareError(null)
    setCapturePending(true)
    try {
      await captureWithConfig(config)
    } catch {
      /* error already surfaced via lastError → ErrorRow */
    } finally {
      setCapturePending(false)
    }
  }

  // The glasses hardware button mirrors the takePhoto() button — same
  // handler, same selected size/mode. Keyed on the event object: each press
  // streams a fresh object, and busy/config are from the render it arrived in.
  useEffect(() => {
    if (latestInputEvent?.kind !== "button") return
    if (busy) return
    void takePhoto()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestInputEvent])

  const warmUp = () => {
    const started = performance.now()
    setWarmupPending(true)
    setWarmupStatus("warming")
    invoke("warmUp", [...buildWarmUpArgs(size, mode, warmupDurationMs)])
      .then(() => {
        setWarmupElapsedMs(performance.now() - started)
        setWarmupStatus("ready")
      })
      .catch(() => {
        setWarmupStatus("failed")
      })
      .finally(() => setWarmupPending(false))
  }

  const sharePhoto = () => {
    if (!result?.photoUrl || sharingRef.current) return
    sharingRef.current = true
    setIsSharing(true)
    setShareError(null)
    invokeSystem("download", [
      {
        url: result.photoUrl,
        mimeType: result.mimeType ?? "image/jpeg",
        filename: `mentra-photo-${result.requestId ?? Date.now()}.${imageExtension(result.mimeType)}`,
      },
    ])
      .then((response) => {
        const downloadResult = response as DownloadResult
        if (!downloadResult?.success) {
          setShareError({
            iface: "system",
            kind: "error",
            payload: {method: "download", message: "The image could not be shared."},
          })
        }
      })
      .catch((error) => {
        setShareError({
          iface: "system",
          kind: "error",
          payload: {
            method: "download",
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })
      .finally(() => {
        sharingRef.current = false
        setIsSharing(false)
      })
  }

  return (
    <Shell>
      <MiniappHeader title="session.camera" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Exercises the Cloud V2 managed-photo API: <code className="mx-1">warmUp()</code> and{" "}
          <code className="mx-1">takePhoto()</code>. Photo mode uses quality tiers (
          <code className="mx-1">low|medium|high|max</code>); text mode uses ASG sensor constants for
          capture/warm-up resolution. The returned URL is a short-TTL (~30 minute) signed download URL.
        </p>

        <TableRow
          emoji="🕶️"
          label="device"
          ordered
          data={{
            modelName: capabilities?.modelName ?? "—",
            hasCamera: capabilities?.hasCamera ?? "—",
            hasWifi: capabilities?.hasWifi ?? "—",
          }}
        />

        <div className="mt-3 flex flex-col gap-3">
          {mode === "photo" && (
            <div>
              <Label htmlFor="photo-size">quality</Label>
              <Select value={size} onValueChange={(value) => setSize(value as PhotoSize)} disabled={busy}>
                <SelectTrigger id="photo-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CANONICAL_PHOTO_SIZES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="photo-mode">mode</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as PhotoMode)} disabled={busy}>
              <SelectTrigger id="photo-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="photo">photo</SelectItem>
                <SelectItem value="text">text</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-3">
            <div className="min-w-0">
              <Label htmlFor="zsl">zsl</Label>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                Zero-shutter-lag preview buffering. Sends{" "}
                <code className="mx-0.5">{zsl ? "true" : "false"}</code> on every takePhoto.
              </p>
            </div>
            <Switch id="zsl" checked={zsl} onCheckedChange={setZsl} disabled={busy} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-3">
            <div className="min-w-0">
              <Label htmlFor="mfnr">mfnr</Label>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                Multi-frame noise reduction capture. Sends{" "}
                <code className="mx-0.5">{mfnr ? "true" : "false"}</code> on every takePhoto.
              </p>
            </div>
            <Switch id="mfnr" checked={mfnr} onCheckedChange={setMfnr} disabled={busy} />
          </div>
          <div>
            <Label htmlFor="warmup-duration">warmUp durationMs</Label>
            <Input
              id="warmup-duration"
              inputMode="numeric"
              value={durationMs}
              onChange={(event) => setDurationMs(event.target.value)}
              disabled={busy}
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={warmUp} disabled={busy} className="sm:flex-1">
              {warmupPending ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner className="size-4" />
                  warming…
                </span>
              ) : (
                "warmUp()"
              )}
            </Button>
            <Button onClick={takePhoto} disabled={busy} className="sm:flex-1">
              {capturePending ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner className="size-4" />
                  capturing…
                </span>
              ) : (
                "takePhoto()"
              )}
            </Button>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Pressing the hardware button on the glasses also runs <code className="mx-1">takePhoto()</code> with the
            selected options.
          </p>
        </div>

        <TableRow
          emoji="📷"
          label="capture options"
          ordered
          data={{
            ...(mode === "photo" ? {size} : {sensor: "ASG text constants"}),
            mode,
            zsl: config.zsl,
            mfnr: config.mfnr,
            warmupDurationMs,
            warmupStatus: warmupStatus ?? "(not warmed)",
            warmupElapsed: formatElapsedMs(warmupElapsedMs),
            captureElapsed: formatElapsedMs(captureElapsedMs),
          }}
        />
        <TableRow
          emoji="🖼️"
          label="latest photo"
          ordered
          data={
            result
              ? {
                  requestId: result.requestId ?? "—",
                  photoUrl: result.photoUrl ?? "—",
                  mimeType: result.mimeType ?? "—",
                  size: formatByteSize(result.size),
                }
              : null
          }
        />
        {result?.photoUrl && (
          <>
            <div className="mt-2 overflow-hidden rounded-xl border border-border">
              <img src={result.photoUrl} alt="Photo captured by the glasses camera" className="w-full" />
            </div>
            <Button variant="outline" className="mt-2 w-full" disabled={busy} onClick={sharePhoto}>
              {isSharing ? "Opening share sheet…" : "Share image"}
            </Button>
          </>
        )}
        <ErrorRow event={lastError} />
        <ErrorRow event={shareError} />
      </div>
    </Shell>
  )
}
