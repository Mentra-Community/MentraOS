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
  createCaptureHistoryEntry,
  DEFAULT_WARMUP_DURATION_MS,
  formatByteSize,
  formatElapsedMs,
  type CaptureHistoryEntry,
  type PhotoCompress,
  type PhotoMode,
  type PhotoSize,
  type PhotoTakenResult,
  type TakePhotoConfig,
} from "./cameraPageModel"

const MAX_HISTORY = 12

function buildConfig(
  size: PhotoSize,
  mode: PhotoMode,
  compress: PhotoCompress,
  sound: boolean,
  saveToGallery: boolean,
  exposureTimeNsRaw: string,
): TakePhotoConfig {
  const parsedExposure = Number.parseInt(exposureTimeNsRaw, 10)
  const exposureTimeNs =
    Number.isFinite(parsedExposure) && parsedExposure > 0 ? parsedExposure : undefined
  return {size, mode, compress, sound, saveToGallery, exposureTimeNs}
}

export default function CameraPage() {
  const navigate = useNavigate()
  const {invoke, lastError} = useTester("camera")
  const snapshot = useChannel("captions:snapshot")
  const capabilities = snapshot?.capabilities

  const [result, setResult] = useState<PhotoTakenResult | undefined>(undefined)
  const [history, setHistory] = useState<CaptureHistoryEntry[]>([])
  const [size, setSize] = useState<PhotoSize>("medium")
  const [mode, setMode] = useState<PhotoMode>("photo")
  const [compress, setCompress] = useState<PhotoCompress>("none")
  const [sound, setSound] = useState(true)
  const [saveToGallery, setSaveToGallery] = useState(false)
  const [exposureTimeNs, setExposureTimeNs] = useState("")
  const [durationMs, setDurationMs] = useState(String(DEFAULT_WARMUP_DURATION_MS))
  const [capturePending, setCapturePending] = useState(false)
  const [warmupPending, setWarmupPending] = useState(false)
  const [matrixPending, setMatrixPending] = useState(false)
  const [warmupStatus, setWarmupStatus] = useState<string | null>(null)
  const [captureElapsedMs, setCaptureElapsedMs] = useState<number | undefined>(undefined)
  const [warmupElapsedMs, setWarmupElapsedMs] = useState<number | undefined>(undefined)

  const parsedDurationMs = Number.parseInt(durationMs, 10)
  const warmupDurationMs =
    Number.isFinite(parsedDurationMs) && parsedDurationMs > 0
      ? parsedDurationMs
      : DEFAULT_WARMUP_DURATION_MS
  const busy = capturePending || warmupPending || matrixPending
  const config = useMemo(
    () => buildConfig(size, mode, compress, sound, saveToGallery, exposureTimeNs),
    [size, mode, compress, sound, saveToGallery, exposureTimeNs],
  )

  const pushHistory = (entry: CaptureHistoryEntry) => {
    setHistory((prev) => [entry, ...prev].slice(0, MAX_HISTORY))
  }

  const captureWithConfig = async (label: string, captureConfig: TakePhotoConfig) => {
    const startedAt = performance.now()
    try {
      const photo = (await invoke("takePhoto", [...buildTakePhotoArgs(captureConfig)])) as PhotoTakenResult
      const elapsedMs = performance.now() - startedAt
      setResult(photo)
      setCaptureElapsedMs(elapsedMs)
      pushHistory(createCaptureHistoryEntry(label, captureConfig, startedAt, elapsedMs, photo))
      return photo
    } catch (err) {
      const elapsedMs = performance.now() - startedAt
      const message = err instanceof Error ? err.message : String(err)
      pushHistory(createCaptureHistoryEntry(label, captureConfig, startedAt, elapsedMs, undefined, message))
      throw err
    }
  }

  const takePhoto = async () => {
    setCapturePending(true)
    try {
      await captureWithConfig("takePhoto", config)
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

  const comparePhotoAndText = async () => {
    setCapturePending(true)
    try {
      await captureWithConfig("photo mode", {...config, mode: "photo"})
      await captureWithConfig("text mode", {...config, mode: "text"})
    } catch {
      /* surfaced via lastError */
    } finally {
      setCapturePending(false)
    }
  }

  const runCanonicalSizeMatrix = async () => {
    setMatrixPending(true)
    try {
      for (const matrixSize of CANONICAL_PHOTO_SIZES) {
        await invoke("warmUp", [...buildWarmUpArgs(matrixSize, warmupDurationMs)])
        await captureWithConfig(`size:${matrixSize}`, {...config, size: matrixSize})
      }
    } catch {
      /* surfaced via lastError */
    } finally {
      setMatrixPending(false)
    }
  }

  return (
    <Shell>
      <MiniappHeader title="session.camera" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Exercises the Cloud V2 managed-photo API: <code className="mx-1">warmUp()</code> and{" "}
          <code className="mx-1">takePhoto()</code> with canonical sizes (
          <code className="mx-1">low|medium|high|max</code>), <code className="mx-1">mode</code>, and{" "}
          <code className="mx-1">compress</code>. The returned URL is a short-TTL (~30 minute) signed download URL.
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
                <SelectItem value="text">text (text-region crop)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="photo-compress">compress</Label>
            <Select
              value={compress}
              onValueChange={(value) => setCompress(value as PhotoCompress)}
              disabled={busy}
            >
              <SelectTrigger id="photo-compress">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">none</SelectItem>
                <SelectItem value="low">low</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="high">high</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="photo-sound">sound</Label>
            <Switch id="photo-sound" checked={sound} onCheckedChange={setSound} disabled={busy} />
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
            <Label htmlFor="exposure-time">exposureTimeNs (optional)</Label>
            <Input
              id="exposure-time"
              inputMode="numeric"
              placeholder="omit for auto exposure"
              value={exposureTimeNs}
              onChange={(event) => setExposureTimeNs(event.target.value)}
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

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={comparePhotoAndText} disabled={busy} className="sm:flex-1">
              Compare photo vs text
            </Button>
            <Button variant="outline" onClick={runCanonicalSizeMatrix} disabled={busy} className="sm:flex-1">
              {matrixPending ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner className="size-4" />
                  running matrix…
                </span>
              ) : (
                "Test low→max sizes"
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
            compress,
            sound,
            saveToGallery,
            exposureTimeNs: config.exposureTimeNs ?? "(auto)",
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
        {history.length > 0 && (
          <TableRow
            emoji="📋"
            label="capture history"
            ordered
            data={history.map((entry) => ({
              label: entry.label,
              elapsed: formatElapsedMs(entry.elapsedMs),
              size: entry.options.size,
              mode: entry.options.mode,
              compress: entry.options.compress,
              bytes: formatByteSize(entry.result?.size),
              requestId: entry.result?.requestId ?? entry.error ?? "—",
            }))}
          />
        )}
        <ErrorRow event={lastError} />
      </div>
    </Shell>
  )
}
