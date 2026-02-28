import React, { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useAuth } from "@mentra/shared";
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
    // Validate package name
    if (!packageName) {
      setError("Missing package name parameter");
      setLoading(false);
      return;
    }

    // Wait for auth to be ready
    if (authLoading || !tokenReady) {
      return;
    }

    // If not authenticated, redirect to login
    if (!isAuthenticated) {
      const returnUrl = `/auth?packagename=${encodeURIComponent(packageName)}`;
      navigate(`/login?returnTo=${encodeURIComponent(returnUrl)}`, {
        state: {
          returnTo: returnUrl,
          message: "Please sign in to continue to the app",
        },
        replace: true,
      });
      return;
    }

    // User is authenticated, fetch app details and show consent
    fetchAppDetailsAndShowConsent();
  }, [packageName, isAuthenticated, authLoading, tokenReady, navigate]);

  const fetchAppDetailsAndShowConsent = async () => {
    if (!packageName) return;

    try {
      setLoading(true);
      setProgress("Fetching app details...");

      // Get app details
      const app = await api.oauth.getAppDetails(packageName);
      setAppDetails(app);

      if (!app.webviewURL) {
        throw new Error("This app does not support web authentication");
      }

      // Show consent screen
      setShowConsent(true);
      setLoading(false);
    } catch (err: any) {
      console.error("Error fetching app details:", err);
      setError(
        err.response?.data?.error ||
          err.message ||
          "Failed to load app details",
      );
      toast.error(
        err.response?.data?.error ||
          err.message ||
          "Failed to load app details",
      );
      setLoading(false);
    }
  };

  const handleAllow = async () => {
    if (!packageName || !appDetails) return;

    try {
      setIsProcessing(true);
      setProgress("Generating authentication token...");

      // Generate signed user token
      const { token } = await api.oauth.generateToken(packageName);

      setProgress("Redirecting to app...");

      // Build redirect URL with token
      const redirectUrl = new URL(appDetails.webviewURL);

      // Add the signed user token as expected by the mobile app
      redirectUrl.searchParams.set("aos_signed_user_token", token);

      // Optional: Add other params the app might expect
      redirectUrl.searchParams.set("source", "oauth");

      // Redirect to app
      setTimeout(() => {
        window.location.href = redirectUrl.toString();
      }, 500); // Small delay for user to see the progress
    } catch (err: any) {
      console.error("OAuth flow error:", err);
      setError(
        err.response?.data?.error || err.message || "Authentication failed",
      );
      toast.error(
        err.response?.data?.error || err.message || "Authentication failed",
      );
      setIsProcessing(false);
    }
  };

  const handleDeny = () => {
    toast.info("Authentication cancelled");
    navigate("/account");
  };

  // Loading state while checking auth or fetching app details
  if (authLoading || !tokenReady || loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full mx-auto p-6">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <p className="text-gray-600">{progress}</p>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full mx-auto p-6">
          <div className="bg-white rounded-lg shadow-md p-8">
            <div className="text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
                <svg
                  className="h-6 w-6 text-red-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                Authentication Error
              </h2>
              <p className="text-gray-600 mb-6">{error}</p>
              <button
                onClick={() => navigate("/account")}
                className="w-full bg-blue-600 text-white rounded-md px-4 py-2 hover:bg-blue-700 transition-colors"
              >
                Return to Account
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Processing state after user clicks Allow
  if (isProcessing) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full mx-auto p-6">
          <div className="bg-white rounded-lg shadow-md p-8">
            <div className="text-center">
              {/* App icon if available */}
              {appDetails?.icon && (
                <img
                  src={appDetails.icon}
                  alt={appDetails.name}
                  className="w-16 h-16 mx-auto mb-4 rounded-lg"
                />
              )}

              {/* Progress indicator */}
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>

              {/* App name */}
              {appDetails && (
                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  Connecting to {appDetails.name}
                </h2>
              )}

              {/* Progress message */}
              <p className="text-gray-600">{progress}</p>

              {/* Additional info */}
              <p className="text-sm text-gray-500 mt-4">
                Please wait while we securely authenticate you...
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Consent screen
  if (showConsent && appDetails) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full mx-auto p-6">
          <div className="bg-white rounded-lg shadow-md p-8">
            <div className="text-center mb-6">
              {/* App icon */}
              {appDetails.icon && (
                <img
                  src={appDetails.icon}
                  alt={appDetails.name}
                  className="w-20 h-20 mx-auto mb-4 rounded-lg shadow-sm"
                />
              )}

              {/* App name */}
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                {appDetails.name}
              </h2>

              {/* Description */}
              {appDetails.description && (
                <p className="text-gray-600 mb-4 text-sm">
                  {appDetails.description}
                </p>
              )}
            </div>

            {/* Authorization request */}
            <div className="border-t border-gray-200 pt-6">
              <div className="text-center mb-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  Authorization Request
                </h3>
                <p className="text-gray-600 text-sm">
                  <strong>{appDetails.name}</strong> wants to access your
                  MentraOS account.
                </p>
              </div>

              {/* User info */}
              <div className="bg-gray-50 rounded-lg p-4 mb-6">
                <div className="flex items-center space-x-3">
                  <div className="flex-shrink-0">
                    <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                      <svg
                        className="w-4 h-4 text-blue-600"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">
                      {user?.email}
                    </p>
                    <p className="text-xs text-gray-500">
                      Signed in to MentraOS
                    </p>
                  </div>
                </div>
              </div>

              {/* Permissions info */}
              <div className="mb-6">
                <h4 className="text-sm font-medium text-gray-900 mb-3">
                  This will allow the app to:
                </h4>
                <ul className="text-sm text-gray-600 space-y-2">
                  <li className="flex items-center">
                    <svg
                      className="w-4 h-4 text-green-500 mr-2 flex-shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Verify your identity
                  </li>
                  <li className="flex items-center">
                    <svg
                      className="w-4 h-4 text-green-500 mr-2 flex-shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Access your basic profile information
                  </li>
                </ul>
              </div>

              {/* Action buttons */}
              <div className="flex space-x-3">
                <button
                  onClick={handleDeny}
                  className="flex-1 bg-gray-100 text-gray-700 rounded-md px-4 py-2 hover:bg-gray-200 transition-colors font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAllow}
                  className="flex-1 bg-blue-600 text-white rounded-md px-4 py-2 hover:bg-blue-700 transition-colors font-medium"
                >
                  Allow
                </button>
              </div>

              {/* Security notice */}
              <p className="text-xs text-gray-500 text-center mt-4">
                By clicking "Allow", you agree to share your information with
                this app securely.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

export default AuthFlowPage;
