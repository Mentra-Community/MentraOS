// components/dialogs/SharingDialog.tsx
import {useEffect, useState, FC} from "react"
import {Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input} from "@mentra/shared"

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
            <p className="text-sm text-muted-foreground">Share this link with anyone to let them install your MiniApp:</p>
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
                {isLinkCopied ? <CheckCircle className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {/* Mentra MiniApp Store Information */}
          <div className="bg-accent/10 border border-accent p-3 rounded-md">
            <p className="text-sm text-link font-medium mb-2">View in Mentra MiniApp Store</p>
            <p className="text-xs text-link mb-3">
              You can also visit the Mentra MiniApp Store and search for the exact package name to see how your MiniApp appears to
              others.
            </p>
            <a
              href={`https://apps.mentra.glass/`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-link hover:text-link hover:underline">
              <ExternalLink className="h-4 w-4" />
              Open in Mentra MiniApp Store
            </a>
            <div className="mt-2 pt-2 border-t border-accent">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="text-xs text-link">Search for:</p>
                  <code className="bg-accent/20 px-1.5 py-0.5 rounded font-mono text-xs">{app?.packageName}</code>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopyPackageName}
                  className="h-7 px-2 hover:bg-accent/20">
                  {isPackageNameCopied ? (
                    <CheckCircle className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-link" />
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
