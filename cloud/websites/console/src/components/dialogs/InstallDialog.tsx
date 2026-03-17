// components/dialogs/InstallDialog.tsx
import {useState} from "react"
import {Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, useAuth} from "@mentra/shared"
import {Download, PackageX, Loader2, CheckCircle, Info} from "lucide-react"
import api from "@/services/api.service"
import {AppI} from "@mentra/sdk"

interface InstallDialogProps {
  app: AppI | null
  open: boolean
  onOpenChange: (open: boolean) => void
  isInstalled: boolean
  onInstallStatusChange?: (packageName: string, installed: boolean) => void
}

const InstallDialog: React.FC<InstallDialogProps> = ({app, open, onOpenChange, isInstalled, onInstallStatusChange}) => {
  const {user} = useAuth()
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Handle install/uninstall confirmation
  const handleConfirm = async () => {
    if (!app) return

    setIsProcessing(true)
    setError(null)
    setSuccess(null)

    try {
      if (isInstalled) {
        // Uninstall the app
        await api.userApps.uninstallApp(app.packageName)
        setSuccess(`${app.name} has been uninstalled successfully!`)

        // Call the callback if provided
        if (onInstallStatusChange) {
          onInstallStatusChange(app.packageName, false)
        }
      } else {
        // Install the app
        await api.userApps.installApp(app.packageName)
        setSuccess(`${app.name} has been installed successfully!`)

        // Call the callback if provided
        if (onInstallStatusChange) {
          onInstallStatusChange(app.packageName, true)
        }
      }

      // Close dialog after a short delay to show success message
      setTimeout(() => {
        setIsProcessing(false)
        onOpenChange(false)
        setSuccess(null)
      }, 1500)
    } catch (err) {
      console.error(`Error ${isInstalled ? "uninstalling" : "installing"} app:`, err)
      setError(`Failed to ${isInstalled ? "uninstall" : "install"} app. Please try again.`)
      setIsProcessing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isInstalled ? (
              <>
                <PackageX className="h-5 w-5 text-warning" />
                Uninstall App
              </>
            ) : (
              <>
                <Download className="h-5 w-5 text-link" />
                Install App
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {app && isInstalled
              ? `Are you sure you want to uninstall ${app.name}?`
              : app
                ? `Do you want to install ${app.name}?`
                : "Do you want to install this app?"}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <div className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">
                {isInstalled ? "You're about to uninstall:" : "You're about to install:"}
              </p>
              <p className="mt-2 font-medium">
                {app?.name} <span className="font-mono text-xs text-muted-foreground">({app?.packageName})</span>
              </p>
            </div>

            {app?.description && (
              <div className="bg-secondary p-3 rounded-md">
                <p className="text-sm text-foreground">{app.description}</p>
              </div>
            )}

            {user?.email && (
              <Alert className="bg-accent/10 border-accent">
                <Info className="h-4 w-4 text-link" />
                <AlertDescription className="text-link text-sm">
                  This will {isInstalled ? "uninstall" : "install"} the app for your account only:{" "}
                  <span className="font-medium">{user.email}</span>
                </AlertDescription>
              </Alert>
            )}
          </div>

          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert className="mt-4 bg-success-light border-success">
              <CheckCircle className="h-4 w-4 text-success" />
              <AlertDescription className="text-success">{success}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isProcessing}>
            Cancel
          </Button>
          <Button variant={isInstalled ? "destructive" : "default"} onClick={handleConfirm} disabled={isProcessing}>
            {isProcessing ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {isInstalled ? "Uninstalling..." : "Installing..."}
              </>
            ) : isInstalled ? (
              "Uninstall App"
            ) : (
              "Install App"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default InstallDialog
