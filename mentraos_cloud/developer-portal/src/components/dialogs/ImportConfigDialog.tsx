import React from 'react';
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2, AlertCircle, Upload } from "lucide-react";

/**
 * Configuration data structure for import validation
 */
interface ImportConfigData {
  name?: string;
  description?: string;
  version?: string;
  settings?: any[];
  tools?: any[];
  publicUrl?: string;
  logoURL?: string;
  webviewURL?: string;
  permissions?: any[];
}

/**
 * Props for the ImportConfigDialog component
 */
interface ImportConfigDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback to change dialog open state */
  onOpenChange: (open: boolean) => void;
  /** Configuration data to import */
  configData: ImportConfigData | null;
  /** Callback when import is confirmed */
  onConfirm: () => void;
  /** Whether the import is in progress */
  isImporting: boolean;
  /** Error message if import validation failed */
  error?: string;
}

/**
 * Dialog component for confirming import of TPA configuration
 *
 * @param props - Component props
 * @returns JSX element
 */
const ImportConfigDialog: React.FC<ImportConfigDialogProps> = ({
  open,
  onOpenChange,
  configData,
  onConfirm,
  isImporting,
  error
}) => {
  // Don't render if no config data and no error
  if (!configData && !error) return null;

  /**
   * Counts the number of settings (excluding groups)
   * @param settings - Array of settings to count
   * @returns Number of non-group settings
   */
  const countSettings = (settings: any[] = []): number => {
    return settings.filter(setting => setting.type !== 'group').length;
  };

  /**
   * Counts the number of tools
   * @param tools - Array of tools to count
   * @returns Number of tools
   */
  const countTools = (tools: any[] = []): number => {
    return tools?.length || 0;
  };

  /**
   * Counts the number of permissions
   * @param permissions - Array of permissions to count
   * @returns Number of permissions
   */
  const countPermissions = (permissions: any[] = []): number => {
    return permissions?.length || 0;
  };

  /**
   * Checks if a URL field has a value
   * @param url - URL string to check
   * @returns Boolean indicating if URL is present
   */
  const hasUrl = (url?: string): boolean => {
    return !!(url && url.trim().length > 0);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Import Configuration
          </DialogTitle>
          <DialogDescription>
            Review the configuration you're about to import.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!error && configData && (
            <>
              {/* Configuration Summary */}
              <div className="border rounded-lg p-4 bg-gray-50">
                <h4 className="font-medium mb-2">Configuration Summary</h4>
                <div className="space-y-1 text-sm text-gray-600">
                  <div><strong>Name:</strong> {configData.name ? configData.name : 'Not provided (will keep current)'}</div>
                  <div><strong>Description:</strong> {configData.description ? configData.description : 'Not provided (will keep current)'}</div>
                </div>
              </div>

              {/* What will be imported */}
              <div className="space-y-2">
                <h4 className="font-medium text-sm">What will be imported:</h4>
                <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
                  {(configData.name || configData.description) && (
                    <li>
                      {configData.name && configData.description
                        ? 'App name and description will be updated'
                        : configData.name
                        ? 'App name will be updated'
                        : 'App description will be updated'
                      }
                    </li>
                  )}
                  <li>All current settings will be replaced with {countSettings(configData.settings)} settings</li>
                  <li>All current tools will be replaced with {countTools(configData.tools)} tools</li>
                  <li>All current permissions will be replaced with {countPermissions(configData.permissions)} permissions</li>
                  {hasUrl(configData.publicUrl) && <li>Server URL will be updated</li>}
                  {hasUrl(configData.logoURL) && <li>Logo URL will be updated</li>}
                  {hasUrl(configData.webviewURL) && <li>Webview URL will be updated</li>}
                </ul>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isImporting}
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isImporting || !!error}
          >
            {isImporting ? (
              <>
                <Upload className="mr-2 h-4 w-4 animate-pulse" />
                Importing...
              </>
            ) : (
              <>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Import Configuration
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ImportConfigDialog;