// Tester page — exercises session.camera via the `tester:invoke` RPC.
// takePhoto() resolves through the RPC reply (the awaited return value of
// invoke()), NOT a streamed tester:event — so capture it in local state.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Label} from "../../components/label"
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "../../components/select"
import {ErrorRow, Row} from "./_TesterRow"

type PhotoSize = "low" | "medium" | "high" | "max"
type PhotoMode = "photo" | "text"

interface PhotoResult {
  requestId?: string
  photoUrl?: string
  mimeType?: string
  size?: number
}

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
  const {invoke: invokeSystem, lastError: systemError} = useTester("system")
  const [result, setResult] = useState<PhotoResult | undefined>(undefined)
  const [size, setSize] = useState<PhotoSize>("medium")
  const [mode, setMode] = useState<PhotoMode>("photo")
  const [isSharing, setIsSharing] = useState(false)

  const takePhoto = () => {
    invoke("takePhoto", [{size, mode}])
      .then((r) => setResult(r as PhotoResult))
      .catch(() => {
        /* error already surfaced via lastError → ErrorRow */
      })
  }

  const sharePhoto = () => {
    if (!result?.photoUrl) return
    setIsSharing(true)
    invokeSystem("download", [
      {
        url: result.photoUrl,
        mimeType: result.mimeType ?? "image/jpeg",
        filename: `mentra-photo-${result.requestId ?? Date.now()}.${imageExtension(result.mimeType)}`,
      },
    ])
      .catch(() => {
        /* error already surfaced via systemError → ErrorRow */
      })
      .finally(() => setIsSharing(false))
  }

  return (
    <Shell>
      <MiniappHeader title="session.camera" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Capture a photo through the glasses camera. Requires <code className="mx-1">CAMERA</code> in the manifest. The
          returned URL is a short-TTL (~24h) Cloudflare R2 signed URL.
        </p>
        <div className="mt-1 flex flex-col gap-3">
          <div>
            <Label htmlFor="photo-size">size</Label>
            <Select value={size} onValueChange={(value) => setSize(value as PhotoSize)}>
              <SelectTrigger id="photo-size">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">low</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="high">high</SelectItem>
                <SelectItem value="max">max</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="photo-mode">mode</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as PhotoMode)}>
              <SelectTrigger id="photo-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="photo">photo</SelectItem>
                <SelectItem value="text">text</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={takePhoto}>takePhoto({`{ size: "${size}", mode: "${mode}" }`})</Button>
        </div>
        <Row emoji="🖼️" label="latest photoUrl" value={result?.photoUrl ?? "(no photo yet)"} />
        {result?.photoUrl && (
          <>
            <div className="mt-2 overflow-hidden rounded-xl border border-border">
              <img src={result.photoUrl} alt="Photo captured by the glasses camera" className="w-full" />
            </div>
            <Button variant="outline" className="mt-2 w-full" disabled={isSharing} onClick={sharePhoto}>
              {isSharing ? "Opening share sheet…" : "Share image"}
            </Button>
          </>
        )}
        <ErrorRow event={lastError} />
        <ErrorRow event={systemError} />
      </div>
    </Shell>
  )
}
