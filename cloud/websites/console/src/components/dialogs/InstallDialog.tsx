// components/dialogs/InstallDialog.tsx
import {useState} from "react"
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import {Button} from "@/components/ui/button"
import {Alert, AlertDescription} from "@/components/ui/alert"
import {Download, PackageX, Loader2, CheckCircle, Info} from "lucide-react"
import api from "@/services/api.service"
import {AppI} from "@mentra/sdk"
import {useAuth} from "@mentra/shared"

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
                <PackageX className="h-5 w-5 text-orange-500" />
                Uninstall App
              </>
            ) : (
              <>
                <Download className="h-5 w-5 text-blue-500" />
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
              <p className="text-sm text-gray-600">
                {isInstalled ? "You're about to uninstall:" : "You're about to install:"}
              </p>
              <p className="mt-2 font-medium">
                {app?.name} <span className="font-mono text-xs text-gray-500">({app?.packageName})</span>
              </p>
            </div>

            {app?.description && (
              <div className="bg-gray-50 p-3 rounded-md">
                <p className="text-sm text-gray-700">{app.description}</p>
              </div>
            )}

            {user?.email && (
              <Alert className="bg-blue-50 border-blue-200">
                <Info className="h-4 w-4 text-blue-600" />
                <AlertDescription className="text-blue-800 text-sm">
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
            <Alert className="mt-4 bg-green-50 border-green-200">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-700">{success}</AlertDescription>
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
