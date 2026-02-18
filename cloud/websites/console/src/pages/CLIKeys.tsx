import {useState, useEffect, FC} from "react"
import {Button} from "@/components/ui/button"
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card"
import {Input} from "@/components/ui/input"
import {Label} from "@/components/ui/label"
import {Alert, AlertDescription} from "@/components/ui/alert"
import {Terminal, Copy, Trash2, Plus, CheckCircle2, AlertCircle, Loader2, Calendar, Key} from "lucide-react"
import DashboardLayout from "../components/DashboardLayout"
import api, {CLIKey, GenerateCLIKeyResponse} from "@/services/api.service"
import {toast} from "sonner"
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

/**
 * CLI Keys Management Page
 *
 * Allows users to generate, view, and revoke CLI API keys for the Mentra CLI tool.
 */
const CLIKeys: FC = () => {
  const [keys, setKeys] = useState<CLIKey[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Generate key state
  const [showGenerateDialog, setShowGenerateDialog] = useState(false)
  const [keyName, setKeyName] = useState("")
  const [expiresInDays, setExpiresInDays] = useState<number | undefined>(undefined)
  const [isGenerating, setIsGenerating] = useState(false)

  // Generated key display
  const [generatedKey, setGeneratedKey] = useState<GenerateCLIKeyResponse | null>(null)
  const [showKeyDialog, setShowKeyDialog] = useState(false)

  // Revoke key state
  const [keyToRevoke, setKeyToRevoke] = useState<CLIKey | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)

  // Load keys on mount
  useEffect(() => {
    loadKeys()
  }, [])

  const loadKeys = async () => {
    try {
      setIsLoading(true)
      setError(null)
      const data = await api.console.cliKeys.list()
      setKeys(data)
    } catch (err: unknown) {
      console.error("Failed to load CLI keys:", err)
      const errorMessage = err instanceof Error ? err.message : "Failed to load CLI keys"
      setError(errorMessage)
      toast.error("Failed to load CLI keys")
    } finally {
      setIsLoading(false)
    }
  }

  const handleGenerateKey = async () => {
    if (!keyName.trim()) {
      toast.error("Key name is required")
      return
    }

    try {
      setIsGenerating(true)
      const result = await api.console.cliKeys.generate({
        name: keyName.trim(),
        expiresInDays,
      })

      setGeneratedKey(result)
      setShowGenerateDialog(false)
      setShowKeyDialog(true)
      setKeyName("")
      setExpiresInDays(undefined)

      // Reload keys list
      await loadKeys()
      toast.success("CLI key generated successfully")
    } catch (err: unknown) {
      console.error("Failed to generate CLI key:", err)
      const errorMessage = err instanceof Error ? err.message : "Failed to generate CLI key"
      toast.error(errorMessage)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleRevokeKey = async () => {
    if (!keyToRevoke) return

    try {
      setIsRevoking(true)
      await api.console.cliKeys.revoke(keyToRevoke.keyId)
      toast.success(`Key "${keyToRevoke.name}" revoked`)
      setKeyToRevoke(null)
      await loadKeys()
    } catch (err: unknown) {
      console.error("Failed to revoke CLI key:", err)
      const errorMessage = err instanceof Error ? err.message : "Failed to revoke CLI key"
      toast.error(errorMessage)
    } finally {
      setIsRevoking(false)
    }
  }

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token)
    toast.success("Token copied to clipboard")
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  }

  return (
    <DashboardLayout>
      <div className="container mx-auto py-8 max-w-6xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">CLI API Keys</h1>
          <p className="text-gray-600">
            Manage API keys for the Mentra CLI tool. Use these keys to authenticate and manage your apps from the
            command line.
          </p>
        </div>

        {/* Installation Instructions */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal className="w-5 h-5" />
              Getting Started
            </CardTitle>
            <CardDescription>Install and authenticate the Mentra CLI tool</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm font-semibold">1. Install the CLI</Label>
              <div className="mt-2 p-3 bg-gray-900 text-gray-100 rounded-md font-mono text-sm">
                npm install -g @mentra/cli
              </div>
            </div>
            <div>
              <Label className="text-sm font-semibold">2. Generate an API key</Label>
              <p className="text-sm text-gray-600 mt-1">
                Click &quot;Generate New Key&quot; below to create an API key
              </p>
            </div>
            <div>
              <Label className="text-sm font-semibold">3. Authenticate</Label>
              <div className="mt-2 p-3 bg-gray-900 text-gray-100 rounded-md font-mono text-sm">
                mentra auth &lt;your-api-key&gt;
              </div>
            </div>
            <div>
              <Label className="text-sm font-semibold">4. Start using the CLI</Label>
              <div className="mt-2 p-3 bg-gray-900 text-gray-100 rounded-md font-mono text-sm">mentra app list</div>
            </div>
          </CardContent>
        </Card>

        {/* Error Alert */}
        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Keys List */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Key className="w-5 h-5" />
                  Your CLI Keys
                </CardTitle>
                <CardDescription>Manage your CLI API keys. Keys can be revoked at any time.</CardDescription>
              </div>
              <Button onClick={() => setShowGenerateDialog(true)} className="flex items-center gap-2">
                <Plus className="w-4 h-4" />
                Generate New Key
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : keys.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <Terminal className="w-12 h-12 mx-auto mb-3 text-gray-400" />
                <p>No CLI keys yet</p>
                <p className="text-sm">Generate your first key to get started</p>
              </div>
            ) : (
              <div className="space-y-4">
                {keys.map((key) => (
                  <div
                    key={key.keyId}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50 transition-colors">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold">{key.name}</h3>
                        {!key.isActive && (
                          <span className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded">Revoked</span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-sm text-gray-600">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          Created {formatDate(key.createdAt)}
                        </span>
                        {key.lastUsedAt && <span>Last used {formatDate(key.lastUsedAt)}</span>}
                        {key.expiresAt && <span className="text-orange-600">Expires {formatDate(key.expiresAt)}</span>}
                      </div>
                    </div>
                    {key.isActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setKeyToRevoke(key)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50">
                        <Trash2 className="w-4 h-4 mr-1" />
                        Revoke
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Generate Key Dialog */}
        <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Generate New CLI Key</DialogTitle>
              <DialogDescription>Create a new API key for the Mentra CLI tool</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div>
                <Label htmlFor="keyName">Key Name</Label>
                <Input
                  id="keyName"
                  placeholder="e.g., My Laptop, CI/CD Pipeline"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  className="mt-1"
                />
                <p className="text-xs text-gray-500 mt-1">Choose a name to help you identify this key</p>
              </div>
              <div>
                <Label htmlFor="expiresInDays">Expiration (optional)</Label>
                <Input
                  id="expiresInDays"
                  type="number"
                  placeholder="Never expires"
                  value={expiresInDays || ""}
                  onChange={(e) => setExpiresInDays(e.target.value ? parseInt(e.target.value) : undefined)}
                  className="mt-1"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Number of days until the key expires (leave empty for no expiration)
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowGenerateDialog(false)} disabled={isGenerating}>
                Cancel
              </Button>
              <Button onClick={handleGenerateKey} disabled={isGenerating || !keyName.trim()}>
                {isGenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4 mr-2" />
                    Generate Key
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Show Generated Key Dialog */}
        <Dialog open={showKeyDialog} onOpenChange={setShowKeyDialog}>
          <DialogContent className="sm:max-w-[600px] max-h-[85vh] flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                CLI Key Generated
              </DialogTitle>
              <DialogDescription>Copy this key now - it won&apos;t be shown again</DialogDescription>
            </DialogHeader>
            {generatedKey && (
              <div className="space-y-4 py-4 overflow-y-auto flex-1">
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    <strong>Important:</strong> This is the only time you&apos;ll see this key. Copy it now and store it
                    securely.
                  </AlertDescription>
                </Alert>
                <div>
                  <Label className="text-sm font-semibold">Key Name</Label>
                  <p className="mt-1">{generatedKey.name}</p>
                </div>
                <div>
                  <Label className="text-sm font-semibold">API Key</Label>
                  <div className="mt-2 p-3 bg-gray-900 text-gray-100 rounded-md font-mono text-xs break-all flex items-start gap-2">
                    <span className="flex-1 leading-relaxed">{generatedKey.token}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => copyToken(generatedKey.token)}
                      className="text-gray-300 hover:text-white hover:bg-gray-800 shrink-0">
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-semibold">Authenticate with CLI</Label>
                  <div className="mt-2 p-3 bg-gray-900 text-gray-100 rounded-md font-mono text-xs break-all leading-relaxed">
                    mentra auth {generatedKey.token}
                  </div>
                </div>
                {generatedKey.expiresAt && (
                  <div>
                    <Label className="text-sm font-semibold">Expires</Label>
                    <p className="mt-1 text-sm text-gray-600">{formatDate(generatedKey.expiresAt)}</p>
                  </div>
                )}
              </div>
            )}
            <DialogFooter className="flex-shrink-0">
              <Button
                onClick={() => {
                  setShowKeyDialog(false)
                  setGeneratedKey(null)
                }}
                className="w-full sm:w-auto">
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Revoke Key Confirmation */}
        <AlertDialog open={!!keyToRevoke} onOpenChange={(open) => !open && setKeyToRevoke(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke CLI Key?</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to revoke the key &quot;{keyToRevoke?.name}&quot;? This action cannot be undone
                and any tools using this key will immediately lose access.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleRevokeKey}
                disabled={isRevoking}
                className="bg-red-600 hover:bg-red-700">
                {isRevoking ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Revoking...
                  </>
                ) : (
                  "Revoke Key"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DashboardLayout>
  )
}

export default CLIKeys
