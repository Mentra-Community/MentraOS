// components/dialogs/AppSuccessDialog.tsx
import React, { useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@mentra/shared";
import { AppResponse } from '@/services/api.service';
import { toast } from 'sonner';
import { CheckCircle, KeyRound, Copy, ArrowRight, AlertCircle } from "lucide-react";
import { useNavigate } from 'react-router-dom';

interface AppSuccessDialogProps {
  app: AppResponse | null;
  apiKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewApiKey: () => void;
}

const AppSuccessDialog: React.FC<AppSuccessDialogProps> = ({
  app,
  apiKey,
  open,
  onOpenChange,
  onViewApiKey
}) => {
  const navigate = useNavigate();
  const [isCopied, setIsCopied] = useState(false);

  const handleCopyApiKey = React.useCallback(() => {
    if (!apiKey) return;

    navigator.clipboard.writeText(apiKey).then(() => {
      setIsCopied(true);
      toast.success('API key copied to clipboard');
      setTimeout(() => setIsCopied(false), 2000);
    });
  }, [apiKey]);

  // Auto-copy API key when dialog opens
  React.useEffect(() => {
    if (open && apiKey) {
      handleCopyApiKey();
    }
  }, [open, apiKey, handleCopyApiKey]);

  const handleGoToApps = () => {
    onOpenChange(false);
    navigate('/apps');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-success" />
            App Created Successfully
          </DialogTitle>
          <DialogDescription>
            {app && `${app.name} has been created successfully.`}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          <div className="bg-success-light border-l-4 border-success border-t border-r border-b rounded-md p-4 text-success shadow-sm">
            <p className="text-sm font-medium">Your app is now ready! 🎉</p>
            <p className="text-sm mt-1">Your API key has been automatically copied to your clipboard.</p>
          </div>

          {apiKey ? (
            <div className="space-y-2">
              <p className="text-sm font-medium flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                Your API Key
              </p>
              <div className="flex items-center gap-2">
                <div className="flex-1 font-mono text-sm p-3 border-2 border-accent rounded-md bg-accent/10 overflow-x-auto shadow-sm">
                  {apiKey}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyApiKey}
                  className="shrink-0 border-accent"
                >
                  {isCopied ?
                    <CheckCircle className="h-4 w-4 text-success" /> :
                    <Copy className="h-4 w-4" />
                  }
                </Button>
              </div>
              <div className="flex items-center text-xs text-destructive font-medium bg-destructive/10 p-2 rounded-md border border-destructive">
                <AlertCircle className="h-4 w-4 mr-1 shrink-0" />
                Important: This key will only be shown once. Save it securely!
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                API Key
              </p>
              <Button
                onClick={onViewApiKey}
                className="w-full"
                variant="outline"
              >
                Generate API Key
              </Button>
              <p className="text-xs text-muted-foreground">
                Generate an API key to authenticate your app with MentraOS.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-end gap-2">
          {apiKey && (
            <Button
              onClick={handleCopyApiKey}
              variant="outline"
              className="mr-auto gap-2"
            >
              {isCopied ? 'Copied!' : 'Copy API Key Again'}
              <Copy className="h-4 w-4" />
            </Button>
          )}
          <Button onClick={handleGoToApps} className="gap-2">
            Go to My Apps
            <ArrowRight className="h-4 w-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AppSuccessDialog;