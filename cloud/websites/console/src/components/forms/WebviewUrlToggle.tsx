import React, { useState, useEffect } from "react";
import { Input, Label, Switch } from "@mentra/shared";
import { normalizeUrl } from "@/libs/utils";
import { cn } from "@/libs/utils";

interface WebviewUrlToggleProps {
  /** Current webview URL value */
  value: string;
  /** Server URL value (used to construct default webview URL) */
  serverUrl: string;
  /** Callback when webview URL changes */
  onChange: (value: string) => void;
  /** Callback when URL field loses focus (for normalization) */
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  /** Whether there's a validation error */
  hasError?: boolean;
  /** Error message to display */
  errorMessage?: string;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Input name attribute */
  name?: string;
  /** Input id attribute */
  id?: string;
}

/**
 * WebviewUrlToggle component with toggle for custom webview URL.
 * When toggle is OFF, uses default ${serverUrl}/webview.
 * When toggle is ON, allows custom URL input.
 */
export function WebviewUrlToggle({
  value,
  serverUrl,
  onChange,
  onBlur,
  hasError,
  errorMessage,
  disabled,
  name = "webviewURL",
  id = "webviewURL",
}: WebviewUrlToggleProps) {
  // Determine if custom URL is enabled based on whether value differs from default
  const getDefaultWebviewUrl = (server: string): string => {
    if (!server) return "";
    try {
      const normalized = normalizeUrl(server);
      // Remove trailing slash if present
      const base = normalized.replace(/\/$/, "");
      return `${base}/webview`;
    } catch {
      return "";
    }
  };

  const defaultUrl = getDefaultWebviewUrl(serverUrl);

  // Check if the current value is custom (different from default)
  const isCustomUrl = Boolean(value && value !== "" && value !== defaultUrl);

  const [useCustomUrl, setUseCustomUrl] = useState<boolean>(isCustomUrl);

  // Update toggle state when value or serverUrl changes
  useEffect(() => {
    const newDefault = getDefaultWebviewUrl(serverUrl);
    const isCustom = Boolean(value && value !== "" && value !== newDefault);
    setUseCustomUrl(isCustom);
  }, [value, serverUrl]);

  const handleToggleChange = (checked: boolean) => {
    setUseCustomUrl(checked);
    if (!checked) {
      // When switching to default, clear the custom value
      // The parent will handle sending the default URL to the backend
      onChange("");
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>Webview URL</Label>
        <div className="flex items-center gap-2">
          <Label
            htmlFor="webview-toggle"
            className="text-sm text-muted-foreground font-normal"
          >
            Use custom URL
          </Label>
          <Switch
            id="webview-toggle"
            checked={useCustomUrl}
            onCheckedChange={handleToggleChange}
            disabled={disabled}
          />
        </div>
      </div>

      {useCustomUrl ? (
        <div className="space-y-2">
          <Input
            id={id}
            name={name}
            value={value}
            onChange={handleInputChange}
            onBlur={onBlur}
            placeholder="yourserver.com/custom-webview"
            className={cn(hasError && "border-destructive")}
            disabled={disabled}
          />
          {hasError && errorMessage && (
            <p className="text-xs text-destructive">{errorMessage}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Enter a custom URL for your MiniApp&apos;s mobile companion interface.
            HTTPS is required and will be added automatically if not specified.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-3 py-2 bg-secondary border rounded-md">
            <span className="text-sm text-muted-foreground font-mono">
              {defaultUrl || "(Enter Server URL first)"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Using default webview URL based on your Server URL. Toggle on to use
            a custom URL.
          </p>
        </div>
      )}
    </div>
  );
}

export default WebviewUrlToggle;
