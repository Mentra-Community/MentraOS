// Tester page — exercises session.camera. The takePhoto buttons call
// `tester:invoke` and render the RPC's resolved PhotoResult directly; the
// tester:event channel is still consumed (latestByKind) for any controller-
// emitted results so both paths surface.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {ErrorRow, Row, StatusRow} from "./_TesterRow"

interface PhotoResult {
  photoUrl?: string
  mimeType?: string
  size?: number
}

export default function CameraPage() {
  const navigate = useNavigate()
  const {latestByKind, log, invoke, lastError, status} = useTester("camera")
  const [photo, setPhoto] = useState<PhotoResult | null>(null)

  // Event-channel fallback: a controller-driven fire also lands here.
  const latestResult = latestByKind("result")
  const eventResult = latestResult
    ? ((latestResult.payload as {result?: PhotoResult}).result as PhotoResult | undefined)
    : undefined
  const result = photo ?? eventResult

  const takePhoto = (size: "small" | "medium" | "large") => {
    void invoke("takePhoto", [{size}])
      .then((r) => setPhoto(r as PhotoResult))
      .catch(() => {}) // StatusRow renders the structured failure
  }

  return (
    <Shell>
      <MiniappHeader title="session.camera" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Capture a photo through the glasses camera. Requires{" "}
          <code className="mx-1">CAMERA</code> in the manifest. The returned URL
          is a short-TTL signed URL (Cloudflare R2 in prod, the local runtime's
          blob store in dev).
        </p>
        <div className="mt-1 flex flex-col gap-2">
          <Button onClick={() => takePhoto("small")}>takePhoto(small)</Button>
          <Button onClick={() => takePhoto("medium")}>takePhoto(medium)</Button>
          <Button onClick={() => takePhoto("large")}>takePhoto(large)</Button>
        </div>
        <Row
          emoji="🖼️"
          label="latest photoUrl"
          value={result?.photoUrl ?? "(no photo yet)"}
          mono
        />
        {result?.photoUrl && (
          <div className="mt-2 overflow-hidden rounded-xl border border-border">
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <img src={result.photoUrl} className="w-full" />
          </div>
        )}
        <StatusRow status={status} />
        <ErrorRow event={lastError} />
        <p className="mt-3 text-[12px] text-muted-foreground">
          {log.length} event(s) seen
        </p>
      </div>
    </Shell>
  )
}
