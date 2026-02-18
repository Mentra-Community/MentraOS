// components/dialogs/SharingDialog.tsx
import {useEffect, useState, FC} from "react"
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"

import {Copy, LinkIcon, CheckCircle, ExternalLink} from "lucide-react"
import api from "@/services/api.service"
import {AppI} from "@mentra/sdk"
import {App} from "@/types/app"

interface SharingDialogProps {
  app: AppI | App | null
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId?: string
}

const SharingDialog: FC<SharingDialogProps> = ({app, open, onOpenChange, orgId}) => {
  // Local states for dialog
  const [isLinkCopied, setIsLinkCopied] = useState(false)
  const [isPackageNameCopied, setIsPackageNameCopied] = useState(false)
  const [shareLink, setShareLink] = useState("")
  const [loadingShareLink, setLoadingShareLink] = useState(true)

  // Get shareable installation link.
  useEffect(() => {
    async function getShareLink() {
      if (open && app) {
        setLoadingShareLink(true)
        try {
          const link = await api.sharing.getInstallLink(app.packageName, orgId)
          setShareLink(link)
        } catch (error) {
          console.error("Failed to get share link:", error)
          setShareLink(`https://apps.mentra.glass/package/${app.packageName}`) // Fallback
        } finally {
          setLoadingShareLink(false)
        }
      }
    }
    getShareLink()
  }, [open, app, orgId])

  // Copy installation link to clipboard
  const handleCopyLink = async () => {
    navigator.clipboard.writeText(shareLink).then(() => {
      setIsLinkCopied(true)
      setTimeout(() => setIsLinkCopied(false), 2000)
    })
  }

  // Copy package name to clipboard
  const handleCopyPackageName = async () => {
    if (app?.packageName) {
      navigator.clipboard.writeText(app.packageName).then(() => {
        setIsPackageNameCopied(true)
        setTimeout(() => setIsPackageNameCopied(false), 2000)
      })
    }
  }

  // When dialog closes, track sharing and reset states
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && app) {
      setIsLinkCopied(false)
      setIsPackageNameCopied(false)
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="h-5 w-5" />
            Installation Link
          </DialogTitle>
          <DialogDescription>{app && `Share ${app.name} with testers`}</DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-6">
          {/* Installation Link Section */}
          <div className="space-y-3">
            <p className="text-sm text-gray-500">Share this link with anyone to let them install your app:</p>
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <Input
                  readOnly
                  value={loadingShareLink ? "Loading..." : shareLink}
                  className="pr-10 font-mono text-sm"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyLink}
                className="shrink-0 ml-2"
                disabled={loadingShareLink}>
                {isLinkCopied ? <CheckCircle className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {/* App Store Information */}
          <div className="bg-blue-50 border border-blue-200 p-3 rounded-md">
            <p className="text-sm text-blue-900 font-medium mb-2">View in MentraOS App Store</p>
            <p className="text-xs text-blue-700 mb-3">
              You can also visit the app store and search for the exact package name to see how your app appears to
              others.
            </p>
            <a
              href={`https://apps.mentra.glass/`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 hover:underline">
              <ExternalLink className="h-4 w-4" />
              Open in App Store
            </a>
            <div className="mt-2 pt-2 border-t border-blue-200">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="text-xs text-blue-600">Search for:</p>
                  <code className="bg-blue-100 px-1.5 py-0.5 rounded font-mono text-xs">{app?.packageName}</code>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopyPackageName}
                  className="h-7 px-2 hover:bg-blue-100">
                  {isPackageNameCopied ? (
                    <CheckCircle className="h-3.5 w-3.5 text-green-600" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-blue-600" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button className="w-100" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default SharingDialog
