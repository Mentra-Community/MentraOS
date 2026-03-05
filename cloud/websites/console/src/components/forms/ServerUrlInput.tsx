import React, { useState, useCallback } from "react";
import { Button, Input, Label } from "@mentra/shared";
import { CheckCircle2, XCircle, Loader2, RefreshCw } from "lucide-react";
import { normalizeUrl } from "@/libs/utils";
import { cn } from "@/libs/utils";
import api from "@/services/api.service";

interface ServerUrlInputProps {
  /** Current URL value */
  value: string;
  /** Callback when URL changes */
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
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

type VerificationStatus = "idle" | "verifying" | "success" | "error";

/**
 * ServerUrlInput component with built-in URL verification.
 * Checks server reachability by hitting the /health endpoint.
 */
export function ServerUrlInput({
  value,
  onChange,
  onBlur,
  hasError,
  errorMessage,
  disabled,
  name = "publicUrl",
  id = "publicUrl",
}: ServerUrlInputProps) {
  const [verificationStatus, setVerificationStatus] =
    useState<VerificationStatus>("idle");
  const [verificationMessage, setVerificationMessage] = useState<string>("");

  const verifyUrl = useCallback(async () => {
    if (!value || value.trim() === "") {
      setVerificationStatus("error");
      setVerificationMessage("Please enter a URL first");
      return;
    }

    try {
      setVerificationStatus("verifying");
      setVerificationMessage("Checking server...");

      // Normalize the URL before verification
      const normalizedUrl = normalizeUrl(value);

      // Call the backend verification endpoint
      const result = await api.apps.verifyServerUrl(normalizedUrl);

      if (result.reachable) {
        setVerificationStatus("success");
        setVerificationMessage(
          result.message || "Server is reachable"
        );
      } else {
        setVerificationStatus("error");
        setVerificationMessage(
          result.message || "Server is not reachable"
        );
      }
    } catch (error: unknown) {
      console.error("URL verification error:", error);
      setVerificationStatus("error");
      const errMsg =
        error instanceof Error ? error.message : "Failed to verify URL";
      setVerificationMessage(errMsg);
    }
  }, [value]);

  const getStatusIcon = () => {
    switch (verificationStatus) {
      case "verifying":
        return <Loader2 className="h-4 w-4 animate-spin text-link" />;
      case "success":
        return <CheckCircle2 className="h-4 w-4 text-success" />;
      case "error":
        return <XCircle className="h-4 w-4 text-destructive" />;
      default:
        return null;
    }
  };

  const getStatusColor = () => {
    switch (verificationStatus) {
      case "success":
        return "text-success";
      case "error":
        return "text-destructive";
      default:
        return "text-muted-foreground";
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        Server URL <span className="text-destructive">*</span>
      </Label>
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <Input
            id={id}
            name={name}
            value={value}
            onChange={onChange}
            onBlur={onBlur}
            placeholder="yourserver.com"
            className={cn(hasError && "border-destructive")}
            disabled={disabled}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={verifyUrl}
          disabled={disabled || verificationStatus === "verifying" || !value}
          className="shrink-0"
        >
          {verificationStatus === "verifying" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          <span className="ml-1">Verify</span>
        </Button>
      </div>

      {/* Error message from form validation */}
      {hasError && errorMessage && (
        <p className="text-xs text-destructive">{errorMessage}</p>
      )}

      {/* Verification status message */}
      {verificationStatus !== "idle" && verificationMessage && (
        <div className={cn("flex items-center gap-1 text-xs", getStatusColor())}>
          {getStatusIcon()}
          <span>{verificationMessage}</span>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        The base URL of your server where MentraOS will communicate with your
        MiniApp. We&apos;ll automatically append &quot;/webhook&quot; to handle
        events when your MiniApp is activated. HTTPS is required and will be
        added automatically if not specified.
      </p>
    </div>
  );
}

export default ServerUrlInput;
