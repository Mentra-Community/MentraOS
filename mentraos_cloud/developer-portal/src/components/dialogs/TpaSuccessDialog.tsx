// components/dialogs/TpaSuccessDialog.tsx
import React, { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AppResponse } from '@/services/api.service';
import { toast } from 'sonner';
import { CheckCircle, KeyRound, Copy, ArrowRight, AlertCircle } from "lucide-react";
import { useNavigate } from 'react-router-dom';

interface TpaSuccessDialogProps {
  tpa: AppResponse | null;
  apiKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewApiKey: () => void;
}

const TpaSuccessDialog: React.FC<TpaSuccessDialogProps> = ({
  tpa,
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

  const handleGoToTpas = () => {
    onOpenChange(false);
    navigate('/tpas');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-green-500" />
            App Created Successfully
          </DialogTitle>
          <DialogDescription>
            {tpa && `${tpa.name} has been created successfully.`}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          <div className="bg-green-50 border-l-4 border-green-500 border-t border-r border-b rounded-md p-4 text-green-800 shadow-sm">
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
                <div className="flex-1 font-mono text-sm p-3 border-2 border-blue-300 rounded-md bg-blue-50 overflow-x-auto shadow-sm">
                  {apiKey}
                </div>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={handleCopyApiKey}
                  className="shrink-0 border-blue-300"
                >
                  {isCopied ? 
                    <CheckCircle className="h-4 w-4 text-green-600" /> : 
                    <Copy className="h-4 w-4" />
                  }
                </Button>
              </div>
              <div className="flex items-center text-xs text-red-600 font-medium bg-red-50 p-2 rounded-md border border-red-200">
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
              <p className="text-xs text-gray-500">
                Generate an API key to authenticate your app with AugmentOS.
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
          <Button onClick={handleGoToTpas} className="gap-2">
            Go to My Apps
            <ArrowRight className="h-4 w-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default TpaSuccessDialog;