/* eslint-disable @typescript-eslint/no-unused-vars */
import { useState, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import {
  ArrowLeft,
  X,
  Calendar,
  Info,
  Mic,
  Camera,
  MapPin,
  Shield,
  Cpu,
  Speaker,
  Wifi,
  RotateCw,
  CircleDot,
  Lightbulb,
} from "lucide-react";
import { useAuth } from "@mentra/shared";
import { useTheme } from "../hooks/useTheme";
import { useIsDesktop } from "../hooks/useMediaQuery";
import { usePlatform } from "../hooks/usePlatform";
import api from "../api";
import { AppI, HardwareType, HardwareRequirementLevel } from "../types";
import { useToast } from "../components/ui/MuiToast";
import { formatCompatibilityError } from "../utils/errorHandling";
import { Button } from "@/components/ui/button";
import Header from "../components/Header";
import AppPermissions from "../components/AppPermissions";
import GetMentraOSButton from "../components/GetMentraOSButton";

// Hardware icon mapping
const hardwareIcons: Record<HardwareType, React.ReactNode> = {
  [HardwareType.CAMERA]: <Camera className="h-4 w-4" />,
  [HardwareType.DISPLAY]: <Cpu className="h-4 w-4" />,
  [HardwareType.MICROPHONE]: <Mic className="h-4 w-4" />,
  [HardwareType.SPEAKER]: <Speaker className="h-4 w-4" />,
  [HardwareType.IMU]: <RotateCw className="h-4 w-4" />,
  [HardwareType.BUTTON]: <CircleDot className="h-4 w-4" />,
  [HardwareType.LIGHT]: <Lightbulb className="h-4 w-4" />,
  [HardwareType.WIFI]: <Wifi className="h-4 w-4" />,
};

// Extend window interface for React Native WebView
declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage: (message: string) => void;
    };
  }
}

const AppDetails: React.FC = () => {
  const { packageName } = useParams<{ packageName: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated } = useAuth();
  const { theme } = useTheme();
  const isDesktop = useIsDesktop();
  const { isWebView } = usePlatform();
  const { showToast } = useToast();

  // Smart navigation function
  const handleBackNavigation = () => {
    // Check if we have history to go back to
    const canGoBack = window.history.length > 1;

    // Check if the referrer is from the same domain
    const referrer = document.referrer;
    const currentDomain = window.location.hostname;

    if (canGoBack && referrer) {
      try {
        const referrerUrl = new URL(referrer);
        // If the referrer is from the same domain, go back
        if (referrerUrl.hostname === currentDomain) {
          navigate(-1);
          return;
        }
      } catch (e) {
        // If parsing fails, fall through to navigate home
      }
    }

    // Otherwise, navigate to the homepage
    navigate("/");
  };

  const [app, setApp] = useState<AppI | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installingApp, setInstallingApp] = useState<boolean>(false);

  // Fetch app details on component mount
  useEffect(() => {
    if (packageName) {
      fetchAppDetails(packageName);
    }
  }, [packageName, isAuthenticated]);

  /**
   * Navigates to the app store filtered by the given organization ID
   * @param orgId Organization ID to filter by
   */
  const navigateToOrgApps = (orgId: string) => {
    navigate(`/?orgId=${orgId}`);
  };

  // Get icon for permission type
  const getPermissionIcon = (type: string) => {
    const normalizedType = type.toLowerCase();
    if (normalizedType.includes("microphone") || normalizedType.includes("audio")) {
      return <Mic className="h-5 w-4" />;
    }
    if (normalizedType.includes("camera") || normalizedType.includes("photo")) {
      return <Camera className="h-4 w-4" />;
    }
    if (normalizedType.includes("location") || normalizedType.includes("gps")) {
      return <MapPin className="h-4 w-4" />;
    }
    if (normalizedType.includes("calendar")) {
      return <Calendar className="h-4 w-4" />;
    }
    return <Shield className="h-4 w-4" />;
  };

  // Get default description for permission type
  const getPermissionDescription = (type: string) => {
    const normalizedType = type.toLowerCase();
    if (normalizedType.includes("microphone") || normalizedType.includes("audio")) {
      return "For voice import and audio processing.";
    }
    if (normalizedType.includes("camera") || normalizedType.includes("photo")) {
      return "For capturing photos and recording videos.";
    }
    if (normalizedType.includes("location") || normalizedType.includes("gps")) {
      return "For location-based features and services.";
    }
    if (normalizedType.includes("calendar")) {
      return "For accessing and managing calendar events.";
    }
    return "For app functionality and features.";
  };

  // Fetch app details and install status
  const fetchAppDetails = async (pkgName: string) => {
    try {
      setIsLoading(true);
      setError(null);

      // Get app details
      const result = await api.app.getAppByPackageName(pkgName);
      console.log("Raw app details from API:", result);

      if (!result.app) {
        setError("App not found");
        return;
      }

      const appDetails = result.app;

      // If authenticated, check if app is installed
      if (isAuthenticated) {
        try {
          // Get user's installed apps
          const installedApps = await api.app.getInstalledApps();

          // Check if this app is installed
          const isInstalled = installedApps.some((app) => app.packageName === pkgName);

          // Update app with installed status
          appDetails.isInstalled = isInstalled;

          if (isInstalled) {
            // Find installed date from the installed apps
            const installedApp = installedApps.find((app) => app.packageName === pkgName);
            if (installedApp && installedApp.installedDate) {
              appDetails.installedDate = installedApp.installedDate;
            }
          }
        } catch (err) {
          console.error("Error checking install status:", err);
          // Continue with app details, but without install status
        }
      }

      setApp(appDetails);
    } catch (err) {
      console.error("Error fetching app details:", err);
      setError("Failed to load app details. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  // Handle app installation
  const handleInstall = async () => {
    if (!isAuthenticated) {
      navigate("/login");
      return;
    }

    if (!app) return;

    // Use the web API
    try {
      setInstallingApp(true);

      const success = await api.app.installApp(app.packageName);

      if (success) {
        showToast("App installed successfully", "success");
        setApp((prev) =>
          prev
            ? {
                ...prev,
                isInstalled: true,
                installedDate: new Date().toISOString(),
              }
            : null,
        );
      } else {
        showToast("Failed to install app", "error");
      }
    } catch (err) {
      console.error("Error installing app:", err);

      // Try to get a more informative error message for compatibility issues
      const compatibilityError = formatCompatibilityError(err);
      if (compatibilityError) {
        showToast(compatibilityError, "error");
      } else {
        // Fallback to generic error message
        const errorMessage =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message || "Failed to install app";
        showToast(errorMessage, "error");
      }
    } finally {
      setInstallingApp(false);
    }
  };

  // Deprecated: No longer used after removing Open button
  // const handleOpen = (packageName: string) => {
  //   // If we're in webview, send message to React Native to open TPA settings
  //   if (isWebView && window.ReactNativeWebView) {
  //     window.ReactNativeWebView.postMessage(
  //       JSON.stringify({
  //         type: "OPEN_APP_SETTINGS",
  //         packageName: packageName,
  //       }),
  //     );
  //   } else {
  //     // Fallback: refresh the page
  //     window.location.reload();
  //   }
  // };

  // Handle app uninstallation
  const handleUninstall = async () => {
    if (!isAuthenticated || !app) return;

    try {
      setInstallingApp(true);

      // First stop the app
      // const stopSuccess = await api.app.stopApp(app.packageName);
      // if (!stopSuccess) {
      //   toast.error('Failed to stop app before uninstallation');
      //   return;
      // }
      // App should be stopped automatically by the backend when uninstalling.

      // Then uninstall the app
      console.log("Uninstalling app:", app.packageName);
      const uninstallSuccess = await api.app.uninstallApp(app.packageName);

      if (uninstallSuccess) {
        showToast("App uninstalled successfully", "success");
        setApp((prev) => (prev ? { ...prev, isInstalled: false, installedDate: undefined } : null));
      } else {
        showToast("Failed to uninstall app", "error");
      }
    } catch (err) {
      console.error("Error uninstalling app:", err);
      showToast("Failed to uninstall app. Please try again.", "error");
    } finally {
      setInstallingApp(false);
    }
  };

  // Formatted date for display
  const formatDate = (dateString?: string) => {
    if (!dateString) return "N/A";
    return new Date(dateString).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  return (
    <>
      {/* Show header on mobile screens */}
      <div className="sm:hidden">
        <Header />
      </div>

      <div
        className="min-h-screen sm:flex sm:items-center sm:justify-center sm:p-4"
        style={{
          backgroundColor: "var(--bg-primary)",
          color: "var(--text-primary)",
        }}>
        {/* Error state */}
        {!isLoading && error && <div className="text-red-500 p-4">{error}</div>}

        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center min-h-[50vh]">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
          </div>
        )}

        {/* Main content */}
        {!isLoading && !error && app && (
          <div
            className="w-full sm:max-w-[90vw] sm:w-[720px] sm:max-w-[720px] min-h-screen sm:min-h-0 sm:max-h-[90vh] overflow-y-auto sm:rounded-[24px] custom-scrollbar relative"
            style={{
              // Mobile styles (default)
              backgroundColor: "var(--bg-primary)",
              // Desktop styles applied based on media query hook
              ...(isDesktop
                ? {
                    backgroundColor: theme === "light" ? "#ffffff" : "var(--bg-secondary)",
                    boxShadow: theme === "light" ? "0 0 0 1px #e5e5e5" : "inset 0 0 0 1px rgba(255, 255, 255, 0.1)",
                    border: theme === "light" ? "1px solid #e5e5e5" : "none",
                  }
                : {}),
            }}>
            {/* Desktop Close Button */}
            <button
              onClick={handleBackNavigation}
              className="hidden sm:block absolute top-6 right-6 transition-colors"
              style={{
                color: theme === "light" ? "#000000" : "#9CA3AF",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = theme === "light" ? "#333333" : "#ffffff")}
              onMouseLeave={(e) => (e.currentTarget.style.color = theme === "light" ? "#000000" : "#9CA3AF")}
              aria-label="Close">
              <X className="h-6 w-6" />
            </button>

            {/* Mobile Back Button */}
            <div className="sm:hidden px-6 py-4 border-b" style={{ borderColor: "var(--border-color)" }}>
              <button
                onClick={handleBackNavigation}
                className="flex items-center gap-2 transition-colors"
                style={{ color: "var(--text-primary)" }}>
                <ArrowLeft className="h-5 w-5" />
                <span className="text-[16px]">Back</span>
              </button>
            </div>

            {/* Content wrapper with responsive padding */}
            <div className="px-6 py-6 pb-safe sm:p-12 sm:pb-16">
              <div className="max-w-2xl mx-auto sm:max-w-none">
                {/* Header */}
                <div className="flex items-start justify-between mb-8 sm:items-center">
                  <div className="flex items-center gap-4">
                    <img
                      src={app.logoURL}
                      alt={`${app.name} logo`}
                      className="w-16 h-16 object-cover rounded-full flex-shrink-0"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = "https://placehold.co/64x64/gray/white?text=App";
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <h2
                        id="app-modal-title"
                        className="text-[24px] font-medium leading-[1.2] break-words"
                        style={{
                          fontFamily: '"Red Hat Display", sans-serif',
                          letterSpacing: "0.02em",
                          color: "var(--text-primary)",
                        }}>
                        {app.name}
                      </h2>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 flex-shrink-0 ml-4">
                    {isAuthenticated ? (
                      app.isInstalled ? (
                        // Deprecated: Open button functionality
                        // isWebView ? (
                        //   <Button
                        //     onClick={() => handleOpen(app.packageName)}
                        //     disabled={installingApp}
                        //     className="w-[140px] h-[40px] text-[#E2E4FF] text-[16px] font-normal rounded-full"
                        //     style={{
                        //       fontFamily: '"Red Hat Display", sans-serif',
                        //       backgroundColor: "var(--button-bg)",
                        //       color: "var(--button-text)",
                        //     }}
                        //     onMouseEnter={(e) =>
                        //       (e.currentTarget.style.backgroundColor =
                        //         "var(--button-hover)")
                        //     }
                        //     onMouseLeave={(e) =>
                        //       (e.currentTarget.style.backgroundColor =
                        //         "var(--button-bg)")
                        //     }
                        //   >
                        //     Open
                        //   </Button>
                        // ) : (
                        // Show greyed out Installed button for installed apps on desktop/mobile
                        <Button
                          disabled={true}
                          className="w-[140px] h-[40px] text-[#E2E4FF] text-[16px] font-normal rounded-full opacity-30 cursor-not-allowed"
                          style={{
                            fontFamily: '"Red Hat Display", sans-serif',
                            backgroundColor: "var(--button-bg)",
                            color: "var(--button-text)",
                            filter: "grayscale(100%)",
                          }}>
                          Installed
                        </Button>
                      ) : (
                        // )
                        <Button
                          onClick={handleInstall}
                          disabled={installingApp}
                          className="w-[140px] h-[40px] bg-[#242454] hover:bg-[#2d2f5a] text-[#E2E4FF] text-[16px] font-normal rounded-full"
                          style={{ fontFamily: '"Red Hat Display", sans-serif' }}>
                          {installingApp ? "Installing…" : "Get App"}
                        </Button>
                      )
                    ) : (
                      <Button
                        onClick={() =>
                          navigate("/login", {
                            state: { returnTo: location.pathname },
                          })
                        }
                        className="w-[140px] h-[40px] bg-[#242454] text-[#E2E4FF] text-[16px] font-normal rounded-full"
                        style={{ fontFamily: '"Red Hat Display", sans-serif' }}>
                        Sign in
                      </Button>
                    )}
                  </div>
                </div>

                {app.isOnline === false && (
                  <div className="mb-6">
                    <div
                      className="flex items-center gap-3 p-3 rounded-lg"
                      style={{
                        backgroundColor: theme === "light" ? "#FDECEA" : "rgba(255, 255, 255, 0.05)",
                        border: `1px solid ${theme === "light" ? "#F5C6CB" : "rgba(255, 255, 255, 0.1)"}`,
                      }}>
                      <Info
                        className="h-5 w-5"
                        style={{
                          color: theme === "light" ? "#B91C1C" : "#FCA5A5",
                        }}
                      />
                      <span
                        className="text-[14px]"
                        style={{
                          color: theme === "light" ? "#B91C1C" : "#FCA5A5",
                        }}>
                        This app appears to be offline. Some actions may not work.
                      </span>
                    </div>
                  </div>
                )}

                {/* Description */}
                <div className="mb-8">
                  <p
                    className="text-[16px] font-normal leading-[1.6] sm:max-w-[480px]"
                    style={{
                      fontFamily: '"Red Hat Display", sans-serif',
                      color: theme === "light" ? "#000000" : "#E4E4E7",
                    }}>
                    {app.description || "No description available."}
                  </p>
                </div>

                {/* Information Section */}
                <div className="mb-8">
                  <h3
                    className="text-[12px] font-semibold uppercase mb-6"
                    style={{
                      fontFamily: '"Red Hat Display", sans-serif',
                      letterSpacing: "0.05em",
                      color: theme === "light" ? "#000000" : "#9CA3AF",
                    }}>
                    Information
                  </h3>

                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <span
                        className="text-[14px] font-medium"
                        style={{
                          color: theme === "light" ? "#000000" : "#9CA3AF",
                        }}>
                        Company
                      </span>
                      <span
                        className="text-[14px] font-normal text-right"
                        style={{
                          color: theme === "light" ? "#000000" : "#E4E4E7",
                        }}>
                        {app.orgName || app.developerProfile?.company || "Mentra"}
                      </span>
                    </div>

                    {app.developerProfile?.website && (
                      <div className="flex justify-between items-center">
                        <span
                          className="text-[14px] font-medium"
                          style={{
                            color: theme === "light" ? "#000000" : "#9CA3AF",
                          }}>
                          Website
                        </span>
                        <a
                          href={app.developerProfile.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[14px] font-normal hover:underline text-right"
                          style={{
                            color: theme === "light" ? "#000000" : "#E4E4E7",
                          }}>
                          {app.developerProfile.website}
                        </a>
                      </div>
                    )}

                    {app.developerProfile?.contactEmail && (
                      <div className="flex justify-between items-center">
                        <span
                          className="text-[14px] font-medium"
                          style={{
                            color: theme === "light" ? "#000000" : "#9CA3AF",
                          }}>
                          Contact
                        </span>
                        <a
                          href={`mailto:${app.developerProfile.contactEmail}`}
                          className="text-[14px] font-normal hover:underline text-right"
                          style={{
                            color: theme === "light" ? "#000000" : "#E4E4E7",
                          }}>
                          {app.developerProfile.contactEmail}
                        </a>
                      </div>
                    )}

                    <div className="flex justify-between items-center">
                      <span
                        className="text-[14px] font-medium"
                        style={{
                          color: theme === "light" ? "#000000" : "#9CA3AF",
                        }}>
                        App Type
                      </span>
                      <span
                        className="text-[14px] font-normal text-right capitalize"
                        style={{
                          color: theme === "light" ? "#000000" : "#E4E4E7",
                        }}>
                        {(() => {
                          const appType = app.appType ?? app.tpaType ?? "Foreground";
                          return appType === "standard" ? "Foreground" : appType;
                        })()}
                      </span>
                    </div>

                    <div className="flex justify-between items-center">
                      <span
                        className="text-[14px] font-medium"
                        style={{
                          color: theme === "light" ? "#000000" : "#9CA3AF",
                        }}>
                        Package
                      </span>
                      <span
                        className="text-[14px] font-normal text-right"
                        style={{
                          color: theme === "light" ? "#000000" : "#E4E4E7",
                        }}>
                        {app.packageName.replace(".augmentos.", ".mentra.")}{" "}
                        {/* TODO: remove this once we have migrated over */}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Required Permissions - Improved Formatting */}
                <div className="mb-6">
                  <h3
                    className="text-[12px] font-semibold uppercase mb-6"
                    style={{
                      fontFamily: '"Red Hat Display", sans-serif',
                      letterSpacing: "0.05em",
                      color: theme === "light" ? "#000000" : "#9CA3AF",
                    }}>
                    Required Permissions
                  </h3>
                  <div className="space-y-4">
                    {app.permissions && app.permissions.length > 0 ? (
                      app.permissions.map((permission, index) => (
                        <div
                          key={index}
                          className="flex items-start gap-3 p-3 rounded-lg"
                          style={{
                            backgroundColor: theme === "light" ? "#f8f9fa" : "rgba(255, 255, 255, 0.05)",
                            border: `1px solid ${theme === "light" ? "#e9ecef" : "rgba(255, 255, 255, 0.1)"}`,
                          }}>
                          <div
                            className="flex-shrink-0 mt-0.5"
                            style={{
                              color: theme === "light" ? "#6c757d" : "#9CA3AF",
                            }}>
                            {getPermissionIcon(permission.type || "Microphone")}
                          </div>
                          <div className="flex-1">
                            <div
                              className="text-[14px] font-semibold mb-1"
                              style={{
                                color: theme === "light" ? "#000000" : "#E4E4E7",
                              }}>
                              {(permission.type || "Microphone").charAt(0).toUpperCase() +
                                (permission.type || "Microphone").slice(1).toLowerCase()}
                            </div>
                            <div
                              className="text-[13px] leading-[1.4]"
                              style={{
                                color: theme === "light" ? "#6c757d" : "#9CA3AF",
                              }}>
                              {permission.description || getPermissionDescription(permission.type || "Microphone")}
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div
                        className="text-center py-6 rounded-lg"
                        style={{
                          backgroundColor: theme === "light" ? "#f8f9fa" : "rgba(255, 255, 255, 0.05)",
                          border: `1px solid ${theme === "light" ? "#e9ecef" : "rgba(255, 255, 255, 0.1)"}`,
                        }}>
                        <div
                          className="text-[14px] font-medium"
                          style={{
                            color: theme === "light" ? "#000000" : "#9CA3AF",
                          }}>
                          No special permissions required
                        </div>
                        <div
                          className="text-[12px] mt-1"
                          style={{
                            color: theme === "light" ? "#6c757d" : "#9CA3AF",
                          }}>
                          This app runs with standard system permissions only.
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Hardware Requirements */}
                <div className="mb-6">
                  <h3
                    className="text-[12px] font-semibold uppercase mb-6"
                    style={{
                      fontFamily: '"Red Hat Display", sans-serif',
                      letterSpacing: "0.05em",
                      color: theme === "light" ? "#000000" : "#9CA3AF",
                    }}>
                    Hardware Requirements
                  </h3>
                  <div className="space-y-4">
                    {app.hardwareRequirements && app.hardwareRequirements.length > 0 ? (
                      <div className="space-y-3">
                        {/* Required Hardware */}
                        {app.hardwareRequirements.filter((req) => req.level === HardwareRequirementLevel.REQUIRED)
                          .length > 0 && (
                          <div>
                            <div
                              className="text-[13px] font-medium mb-2"
                              style={{
                                color: theme === "light" ? "#000000" : "#E4E4E7",
                              }}>
                              Required Hardware
                            </div>
                            {app.hardwareRequirements
                              .filter((req) => req.level === HardwareRequirementLevel.REQUIRED)
                              .map((req, index) => (
                                <div
                                  key={`required-${index}`}
                                  className="flex items-start gap-3 p-3 rounded-lg mb-2"
                                  style={{
                                    backgroundColor: theme === "light" ? "#f8f9fa" : "rgba(255, 255, 255, 0.05)",
                                    border: `1px solid ${theme === "light" ? "#e9ecef" : "rgba(255, 255, 255, 0.1)"}`,
                                  }}>
                                  <div
                                    className="flex-shrink-0 mt-0.5"
                                    style={{
                                      color: theme === "light" ? "#6c757d" : "#9CA3AF",
                                    }}>
                                    {hardwareIcons[req.type as HardwareType]}
                                  </div>
                                  <div className="flex-1">
                                    <div
                                      className="text-[14px] font-semibold mb-1"
                                      style={{
                                        color: theme === "light" ? "#000000" : "#E4E4E7",
                                      }}>
                                      {req.type.charAt(0).toUpperCase() + req.type.slice(1).toLowerCase()}
                                    </div>
                                    {req.description && (
                                      <div
                                        className="text-[13px] leading-[1.4]"
                                        style={{
                                          color: theme === "light" ? "#6c757d" : "#9CA3AF",
                                        }}>
                                        {req.description}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                          </div>
                        )}

                        {/* Optional Hardware */}
                        {app.hardwareRequirements.filter((req) => req.level === HardwareRequirementLevel.OPTIONAL)
                          .length > 0 && (
                          <div>
                            <div
                              className="text-[13px] font-medium mb-2"
                              style={{
                                color: theme === "light" ? "#000000" : "#E4E4E7",
                              }}>
                              Optional Hardware
                            </div>
                            {app.hardwareRequirements
                              .filter((req) => req.level === HardwareRequirementLevel.OPTIONAL)
                              .map((req, index) => (
                                <div
                                  key={`optional-${index}`}
                                  className="flex items-start gap-3 p-3 rounded-lg mb-2"
                                  style={{
                                    backgroundColor: theme === "light" ? "#f8f9fa" : "rgba(255, 255, 255, 0.05)",
                                    border: `1px solid ${theme === "light" ? "#e9ecef" : "rgba(255, 255, 255, 0.1)"}`,
                                  }}>
                                  <div
                                    className="flex-shrink-0 mt-0.5"
                                    style={{
                                      color: theme === "light" ? "#6c757d" : "#9CA3AF",
                                    }}>
                                    {hardwareIcons[req.type as HardwareType]}
                                  </div>
                                  <div className="flex-1">
                                    <div
                                      className="text-[14px] font-semibold mb-1"
                                      style={{
                                        color: theme === "light" ? "#000000" : "#E4E4E7",
                                      }}>
                                      {req.type.charAt(0).toUpperCase() + req.type.slice(1).toLowerCase()}
                                    </div>
                                    {req.description && (
                                      <div
                                        className="text-[13px] leading-[1.4]"
                                        style={{
                                          color: theme === "light" ? "#6c757d" : "#9CA3AF",
                                        }}>
                                        {req.description}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        className="text-center py-6 rounded-lg"
                        style={{
                          backgroundColor: theme === "light" ? "#f8f9fa" : "rgba(255, 255, 255, 0.05)",
                          border: `1px solid ${theme === "light" ? "#e9ecef" : "rgba(255, 255, 255, 0.1)"}`,
                        }}>
                        <div
                          className="text-[14px] font-medium"
                          style={{
                            color: theme === "light" ? "#000000" : "#9CA3AF",
                          }}>
                          No specific hardware requirements
                        </div>
                        <div
                          className="text-[12px] mt-1"
                          style={{
                            color: theme === "light" ? "#6c757d" : "#9CA3AF",
                          }}>
                          This app works with any glasses configuration.
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Get MentraOS - Hide in React Native WebView */}
                {!isWebView && (
                  <div className="text-center mb-8">
                    {/* <div className="flex justify-center">
                      <GetMentraOSButton size="small" />
                    </div> */}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default AppDetails;
