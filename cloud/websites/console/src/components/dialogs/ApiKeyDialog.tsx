// components/dialogs/ApiKeyDialog.tsx
import { FC, useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Copy,
  KeyRound,
  RefreshCw,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import api from "@/services/api.service";
import type { AppI } from "@mentra/sdk";
import { App } from "@/types/app";

interface ApiKeyDialogProps {
  app: AppI | App | null;
  apiKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onKeyRegenerated?: (newKey: string) => void;
  orgId?: string;
}

const ApiKeyDialog: FC<ApiKeyDialogProps> = ({
  app,
  open,
  onOpenChange,
  apiKey,
  onKeyRegenerated,
  orgId,
}) => {
  // Local states for dialog
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [_apiKey, setApiKey] = useState("");
  const [isCopied, setIsCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [lastRegenerated, setLastRegenerated] = useState(new Date());
  const [currentAppId, setCurrentAppId] = useState<string | null>(null);

  // Format API key to be partially masked
  const formatApiKey = (key: string): string => {
    if (!key) return "";

    // If there's no key or invalid key, show a masked placeholder
    if (!key || key.length < 10) {
      return "";
    }

    // It's a real key, show it fully (since it's one-time view)
    return key;
  };

  // Copy API key to clipboard
  const handleCopyApiKey = () => {
    navigator["clipboard"].writeText(_apiKey).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    });
  };

  // Start regeneration process
  const handleStartRegenerate = () => {
    setShowConfirmation(true);
  };

  // Cancel regeneration
  const handleCancelRegeneration = () => {
    setShowConfirmation(false);
  };

  // Confirm regeneration
  const handleConfirmRegenerate = async () => {
    if (!app) return;

    setIsRegenerating(true);
    setError(null);
    setSuccess(null);

    try {
      // Call API to regenerate key
      const response = await api.apps.apiKey.regenerate(app.packageName, orgId);
      const newKey = response.apiKey;

      // Update local state
      setApiKey(newKey);
      setLastRegenerated(new Date());
      setSuccess("API key regenerated successfully");
      setShowConfirmation(false);

      // Notify parent component
      if (onKeyRegenerated) {
        onKeyRegenerated(newKey);
      }
    } catch (err: unknown) {
      console.error(err);
      setError("Failed to regenerate API key. Please try again.");
    } finally {
      setIsRegenerating(false);
    }
  };

  // Complete reset of dialog state when App changes
  useEffect(() => {
    if (app) {
      const appId = app.packageName;

      // Only reset state if App has changed
      if (currentAppId !== appId) {
        console.log(
          `App changed from ${currentAppId} to ${appId}, resetting dialog state`,
        );

        // Reset all state
        setApiKey("");
        setError(null);
        setSuccess(null);
        setShowConfirmation(false);
        setIsCopied(false);

        // Update current App ID tracker
        setCurrentAppId(appId);
      }
    }
  }, [app, currentAppId]);

  // Update local state when apiKey prop changes (only if it's a real key)
  useEffect(() => {
    if (apiKey && apiKey.length > 10 && !apiKey.includes("********")) {
      console.log(
        "Setting API key from props:",
        apiKey.substring(0, 5) + "...",
      );
      setApiKey(apiKey);
      setSuccess("API key regenerated successfully");
    }
  }, [apiKey]);

  // Reset dialog state when opened
  useEffect(() => {
    if (open) {
      if (!app) {
        console.warn("ApiKeyDialog opened without a App");
        return;
      }

      // Use the apiKey provided by props if available
      if (apiKey && apiKey.length > 10) {
        setApiKey(apiKey);
      }

      setShowConfirmation(false);
      setIsCopied(false);
    }
  }, [open, app, apiKey]);

  // When dialog closes, reset states
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset dialog state when closing
      setShowConfirmation(false);
      setError(null);
      setSuccess(null);
      setIsCopied(false);

      // Important: Reset the API key when dialog closes
      // This prevents leaking keys between different Apps
      setApiKey("");
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md overflow-y-auto max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            API Key
          </DialogTitle>
          <DialogDescription>
            {app && `API key for ${app.name}`}
          </DialogDescription>
        </DialogHeader>

        <div className="py-6">
          {/* Error Alert */}
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Success Alert */}
          {success && (
            <Alert className="mb-4 bg-green-50 text-green-800 border-green-200">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-700">
                {success}
              </AlertDescription>
            </Alert>
          )}

          {/* Regeneration Confirmation */}
          {showConfirmation ? (
            <div className="space-y-4">
              <Alert
                variant="destructive"
                className="bg-amber-50 border-amber-200 text-amber-800"
              >
                <AlertCircle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-amber-700">
                  Warning: Regenerating this API key will invalidate the
                  previous key. Any applications using the old key will stop
                  working.
                </AlertDescription>
              </Alert>
              <p className="text-sm text-gray-500">
                Are you sure you want to continue?
              </p>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={handleCancelRegeneration}
                  disabled={isRegenerating}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleConfirmRegenerate}
                  disabled={isRegenerating}
                >
                  {isRegenerating ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Regenerating...
                    </>
                  ) : (
                    "Regenerate Key"
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm text-gray-500">
                  Your API key is used to authenticate your app with MentraOS
                  cloud services. Keep it secure and never share it publicly.
                </p>
                {_apiKey ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 font-mono text-sm p-2 border rounded-md bg-gray-50 overflow-x-auto break-all">
                        {formatApiKey(_apiKey)}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCopyApiKey}
                        className="shrink-0"
                      >
                        {isCopied ? (
                          <CheckCircle className="h-4 w-4 text-green-600" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-red-500 font-medium mt-1">
                      Important: This key is only shown once. Please copy it
                      now!
                    </p>
                  </>
                ) : (
                  <div className="p-4 bg-amber-50 border border-amber-200 rounded-md">
                    <p className="text-sm text-amber-800">
                      No API key is available to view. API keys are only shown
                      once when generated and are securely stored.
                    </p>
                    <p className="text-sm text-amber-800 mt-1">
                      Click &quot;Regenerate Key&quot; to create a new API key.
                      This will invalidate any previous keys.
                    </p>
                  </div>
                )}
              </div>

              {/*<div className="space-y-2">
                <h3 className="text-sm font-medium">Webhook URL</h3>
                <div className="font-mono text-sm p-2 border rounded-md bg-gray-50 overflow-x-auto break-all">
                  {app?.publicUrl
                    ? `${app.publicUrl}/webhook`
                    : "No server URL defined"}
                </div>
                <p className="text-xs text-gray-500">
                  This is the full webhook URL where MentraOS will send events
                  to your app.
                </p>
              </div>*/}
            </>
          )}
        </div>

        {!showConfirmation && (
          <DialogFooter className="flex flex-col sm:flex-row items-start sm:items-center sm:justify-between gap-4 sm:gap-2 ">
            <p className="text-xs text-gray-500">
              Last regenerated: {lastRegenerated.toLocaleDateString()}
            </p>
            <div className="flex gap-2 w-full sm:w-auto justify-end">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button variant="destructive" onClick={handleStartRegenerate}>
                Regenerate Key
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ApiKeyDialog;
