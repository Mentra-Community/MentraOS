// Tester page — exercises session.camera via the `tester:invoke` RPC.
// takePhoto() resolves through the RPC reply (the awaited return value of
// invoke()), NOT a streamed tester:event — so capture it in local state.

import {useState} from "react"
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
  const {invoke, lastError} = useTester("camera")
  const [result, setResult] = useState<PhotoResult | undefined>(undefined)

  const takePhoto = (size: "small" | "medium" | "large") => {
    invoke("takePhoto", [{size}])
      .then((r) => setResult(r as PhotoResult))
      .catch(() => {
        /* error already surfaced via lastError → ErrorRow */
      })
  }

  return (
    <Shell>
      <MiniappHeader title="session.camera" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Capture a photo through the glasses camera. Requires{" "}
          <code className="mx-1">CAMERA</code> in the manifest. The returned URL
          is a short-TTL (~24h) Cloudflare R2 signed URL.
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
