// Tester page — exercises session.camera via the `tester:invoke` RPC.
// takePhoto() and warmUp() resolve through the RPC reply (the awaited return
// value of invoke()), NOT a streamed tester:event — so capture results live
// in local state.

import {useMemo, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

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

function buildConfig(
  size: PhotoSize,
  mode: PhotoMode,
  saveToGallery: boolean,
): TakePhotoConfig {
  return {size, mode, saveToGallery}
}

export default function CameraPage() {
  const navigate = useNavigate()
  const {invoke, lastError} = useTester("camera")
  const snapshot = useChannel("captions:snapshot")
  const capabilities = snapshot?.capabilities

  const [result, setResult] = useState<PhotoTakenResult | undefined>(undefined)
  const [size, setSize] = useState<PhotoSize>("medium")
  const [mode, setMode] = useState<PhotoMode>("photo")
  const [saveToGallery, setSaveToGallery] = useState(false)
  const [durationMs, setDurationMs] = useState(String(DEFAULT_WARMUP_DURATION_MS))
  const [capturePending, setCapturePending] = useState(false)
  const [warmupPending, setWarmupPending] = useState(false)
  const [warmupStatus, setWarmupStatus] = useState<string | null>(null)
  const [captureElapsedMs, setCaptureElapsedMs] = useState<number | undefined>(undefined)
  const [warmupElapsedMs, setWarmupElapsedMs] = useState<number | undefined>(undefined)

  const parsedDurationMs = Number.parseInt(durationMs, 10)
  const warmupDurationMs =
    Number.isFinite(parsedDurationMs) && parsedDurationMs > 0
      ? parsedDurationMs
      : DEFAULT_WARMUP_DURATION_MS
  const busy = capturePending || warmupPending
  const config = useMemo(
    () => buildConfig(size, mode, saveToGallery),
    [size, mode, saveToGallery],
  )

  const captureWithConfig = async (captureConfig: TakePhotoConfig) => {
    const startedAt = performance.now()
    const photo = (await invoke("takePhoto", [...buildTakePhotoArgs(captureConfig)])) as PhotoTakenResult
    setResult(photo)
    setCaptureElapsedMs(performance.now() - startedAt)
  }

  const takePhoto = async () => {
    setCapturePending(true)
    try {
      await captureWithConfig(config)
    } catch {
      /* error already surfaced via lastError → ErrorRow */
    } finally {
      setCapturePending(false)
    }
  }

  const warmUp = () => {
    const started = performance.now()
    setWarmupPending(true)
    setWarmupStatus("warming")
    invoke("warmUp", [...buildWarmUpArgs(size, warmupDurationMs)])
      .then(() => {
        setWarmupElapsedMs(performance.now() - started)
        setWarmupStatus("ready")
      })
      .catch(() => {
        setWarmupStatus("failed")
      })
      .finally(() => setWarmupPending(false))
  }

  return (
    <Shell>
      <MiniappHeader title="session.camera" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Exercises the Cloud V2 managed-photo API: <code className="mx-1">warmUp()</code> and{" "}
          <code className="mx-1">takePhoto()</code> with canonical sizes (
          <code className="mx-1">low|medium|high|max</code>) and <code className="mx-1">mode</code>. The returned URL
          is a short-TTL (~30 minute) signed download URL.
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
          <div>
            <Label htmlFor="photo-size">size</Label>
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
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="photo-gallery">saveToGallery</Label>
            <Switch
              id="photo-gallery"
              checked={saveToGallery}
              onCheckedChange={setSaveToGallery}
              disabled={busy}
            />
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
                `warmUp({ size: "${size}", durationMs: ${warmupDurationMs} })`
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

        </div>

        <TableRow
          emoji="📷"
          label="capture options"
          ordered
          data={{
            size,
            mode,
            saveToGallery,
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
          <div className="mt-2 overflow-hidden rounded-xl border border-border">
            <img src={result.photoUrl} alt="Photo captured by the glasses camera" className="w-full" />
          </div>
        )}
        <ErrorRow event={lastError} />
      </div>
    </Shell>
  )
}
