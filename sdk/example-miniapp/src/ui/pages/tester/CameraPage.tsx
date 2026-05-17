// Tester page — exercises session.camera. Background's TesterController
// dispatches the call as a generic `tester:fire` → session.camera.takePhoto;
// the result lands on the tester:event channel as `kind: "result"`.

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {ErrorRow, Row} from "./_TesterRow"

interface PhotoResult {
  photoUrl?: string
  mimeType?: string
  size?: number
}

export default function CameraPage() {
  const navigate = useNavigate()
  const {latestByKind, log, fire, lastError} = useTester("camera")

  const latestResult = latestByKind("result")
  const result = latestResult
    ? ((latestResult.payload as {result?: PhotoResult}).result as PhotoResult | undefined)
    : undefined

  return (
    <Shell>
      <MiniappHeader title="session.camera" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Capture a photo through the glasses camera. Requires{" "}
          <code className="mx-1">CAMERA</code> in the manifest. The returned URL
          is a short-TTL (~24h) Cloudflare R2 signed URL.
        </p>
        <div className="mt-1 flex flex-col gap-2">
          <Button onClick={() => fire("takePhoto", [{size: "small"}])}>
            takePhoto(small)
          </Button>
          <Button onClick={() => fire("takePhoto", [{size: "medium"}])}>
            takePhoto(medium)
          </Button>
          <Button onClick={() => fire("takePhoto", [{size: "large"}])}>
            takePhoto(large)
          </Button>
        </div>
        <Row
          emoji="🖼️"
          label="latest photoUrl"
          value={result?.photoUrl ?? "(no photo yet)"}
        />
        {result?.photoUrl && (
          <div className="mt-2 overflow-hidden rounded-xl border border-border">
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <img src={result.photoUrl} className="w-full" />
          </div>
        )}
        <ErrorRow event={lastError} />
        <p className="mt-3 text-[12px] text-muted-foreground">
          {log.length} event(s) seen
        </p>
      </div>
    </Shell>
  )
}
