import React, { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useAuth, Button, Spinner, IMAGES } from "@mentra/shared";
import api, { AppDetails } from "../services/api.service";
import { toast } from "sonner";

/**
 * AuthFlowPage handles the OAuth-like authentication flow for MentraOS apps.
 *
 * Flow:
 * 1. Check if user is authenticated
 * 2. If not, redirect to login with return URL
 * 3. If authenticated, fetch app details and show consent screen
 * 4. User chooses to allow or deny access
 * 5. If allowed, generate signed user token and redirect to app
 */
const AuthFlowPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, isLoading: authLoading, tokenReady, user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [appDetails, setAppDetails] = useState<AppDetails | null>(null);
  const [showConsent, setShowConsent] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState("Initializing...");

  const packageName = searchParams.get("packagename");

  useEffect(() => {
    if (!packageName) {
      setError("Missing package name parameter");
      setLoading(false);
      return;
    }

    if (authLoading || !tokenReady) {
      return;
    }

    if (!isAuthenticated) {
      const returnUrl = `/auth?packagename=${encodeURIComponent(packageName)}`;
      navigate(`/login?returnTo=${encodeURIComponent(returnUrl)}`, {
        state: {
          returnTo: returnUrl,
          heading: "Sign in to continue",
        },
        replace: true,
      });
      return;
    }

    fetchAppDetailsAndShowConsent();
  }, [packageName, isAuthenticated, authLoading, tokenReady, navigate]);

  const fetchAppDetailsAndShowConsent = async () => {
    if (!packageName) return;

    try {
      setLoading(true);
      setProgress("Fetching app details...");

      const app = await api.oauth.getAppDetails(packageName);
      setAppDetails(app);

      if (!app.webviewURL) {
        throw new Error("This app does not support web authentication");
      }

      setShowConsent(true);
      setLoading(false);
    } catch (err: any) {
      console.error("Error fetching app details:", err);
      const message =
        err.response?.data?.error ||
        err.message ||
        "Failed to load app details";
      setError(message);
      toast.error(message);
      setLoading(false);
    }
  };

  const handleAllow = async () => {
    if (!packageName || !appDetails) return;

    try {
      setIsProcessing(true);
      setProgress("Generating authentication token...");

      const { token } = await api.oauth.generateToken(packageName);

      setProgress("Redirecting to app...");

      const redirectUrl = new URL(appDetails.webviewURL);
      redirectUrl.searchParams.set("aos_signed_user_token", token);
      redirectUrl.searchParams.set("source", "oauth");

      setTimeout(() => {
        window.location.href = redirectUrl.toString();
      }, 500);
    } catch (err: any) {
      console.error("OAuth flow error:", err);
      const message =
        err.response?.data?.error || err.message || "Authentication failed";
      setError(message);
      toast.error(message);
      setIsProcessing(false);
    }
  };

  const canGoBack = window.history.length > 1;

  const handleDeny = () => {
    toast.info("Authentication cancelled");
    window.history.back();
  };

  // Loading state
  if (authLoading || !tokenReady || loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-sm mx-auto flex flex-col items-center">
          <img src={IMAGES.iconOnly} alt="Mentra Logo" className="h-16 w-16 mb-6" />
          <Spinner size="lg" />
          <p className="text-muted-foreground mt-4">{progress}</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-sm mx-auto flex flex-col items-center">
          <img src={IMAGES.iconOnly} alt="Mentra Logo" className="h-16 w-16 mb-6" />
          <p className="text-[46px] text-secondary-foreground text-center pb-4">
            Mentra
          </p>

          <div className="w-full p-4 mb-6 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <span>{error}</span>
            </div>
          </div>

          <Button
            variant="default"
            className="w-full"
            onClick={() => {
              setError(null);
              setLoading(true);
              fetchAppDetailsAndShowConsent();
            }}
          >
            Try Again
          </Button>

        </div>
      </div>
    );
  }

  // Processing state after Allow
  if (isProcessing) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-sm mx-auto flex flex-col items-center">
          {appDetails?.icon ? (
            <img
              src={appDetails.icon}
              alt={appDetails.name}
              className="w-16 h-16 rounded-lg mb-6"
            />
          ) : (
            <img src={IMAGES.iconOnly} alt="Mentra Logo" className="h-16 w-16 mb-6" />
          )}

          <Spinner size="lg" />

          {appDetails && (
            <p className="text-xl font-semibold text-secondary-foreground mt-4">
              Connecting to {appDetails.name}
            </p>
          )}

          <p className="text-muted-foreground mt-2">{progress}</p>
          <p className="text-xs text-muted-foreground mt-4">
            Please wait while we securely authenticate you...
          </p>
        </div>
      </div>
    );
  }

  // Consent screen
  if (showConsent && appDetails) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full max-w-sm mx-auto flex flex-col items-center">
          {/* App icon */}
          {appDetails.icon ? (
            <img
              src={appDetails.icon}
              alt={appDetails.name}
              className="w-20 h-20 rounded-lg mb-4"
            />
          ) : (
            <img src={IMAGES.iconOnly} alt="Mentra Logo" className="h-20 w-20 mb-4" />
          )}

          {/* App name */}
          <p className="text-2xl font-bold text-secondary-foreground text-center mb-1">
            {appDetails.name}
          </p>

          {/* Description */}
          {appDetails.description && (
            <p className="text-sm text-muted-foreground text-center mb-6">
              {appDetails.description}
            </p>
          )}

          {/* Authorization heading */}
          <p className="text-lg font-semibold text-secondary-foreground mb-1">
            Authorization Request
          </p>
          <p className="text-sm text-muted-foreground text-center mb-6">
            <strong>{appDetails.name}</strong> wants to access your Mentra account.
          </p>

          {/* User info */}
          <div className="w-full bg-secondary rounded-lg p-4 mb-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-accent/15 rounded-full flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-accent" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-secondary-foreground">{user?.email}</p>
                <p className="text-xs text-muted-foreground">Signed in to Mentra</p>
              </div>
            </div>
          </div>

          {/* Permissions */}
          <div className="w-full mb-6">
            <p className="text-sm font-medium text-secondary-foreground mb-3">
              This will allow the app to:
            </p>
            <ul className="text-sm text-muted-foreground space-y-2">
              <li className="flex items-center gap-2">
                <svg className="w-4 h-4 text-accent flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Verify your identity
              </li>
              <li className="flex items-center gap-2">
                <svg className="w-4 h-4 text-accent flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Access your basic profile information
              </li>
            </ul>
          </div>

          {/* Action buttons */}
          <div className="w-full flex gap-3">
            {canGoBack && (
              <Button
                variant="secondary"
                className="flex-1"
                onClick={handleDeny}
              >
                Cancel
              </Button>
            )}
            <Button
              variant="default"
              className="flex-1"
              onClick={handleAllow}
            >
              Allow
            </Button>
          </div>

          {/* Security notice */}
          <p className="text-xs text-muted-foreground text-center mt-4">
            By clicking "Allow", you agree to share your information with this app securely.
          </p>
        </div>
      </div>
    );
  }

  return null;
};

export default AuthFlowPage;
