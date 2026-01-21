import { Info, Share2, Smartphone, ChevronLeft, X, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import GetMentraOSButton from "../components/GetMentraOSButton";
import { HardwareRequirementLevel, HardwareType } from "../types";
import {
  APP_TAGS,
  hardwareIcons,
  getPermissionIcon,
  getPermissionDescription,
  getAppTypeDisplay,
  AppDetailsDesktopProps,
} from "./AppDetailsShared";
import { useState } from "react";

const AppDetailsDesktop: React.FC<AppDetailsDesktopProps> = ({
  app,
  isAuthenticated,
  isWebView,
  installingApp,
  handleBackNavigation,
  handleInstall,
  navigateToLogin,
}) => {
  const [selectedImage, setSelectedImage] = useState<{ url: string; index: number } | null>(null);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());

  return (
    <div className="min-h-screen flex justify-center relative z-0">
      {/* Desktop Close Button */}
      {/* <button
        onClick={handleBackNavigation}
        className="absolute top-6 right-6 transition-colors hover:opacity-70"
        style={{
          color: "var(--text-secondary)",
        }}
        aria-label="Close">
        <X className="h-6 w-6" />
      </button> */}

      {/* Content wrapper with responsive padding - matches Header_v2 exactly */}
      <div className="px-4 sm:px-8 md:px-16 lg:px-25 pt-[24px] pb-16 w-full max-w-[1400px]">
        {/* Back Button */}
        <button
          onClick={handleBackNavigation}
          className="flex items-center justify-center w-[40px] h-[40px] rounded-full mb-[32px] transition-all hover:scale-105 hover:opacity-80"
          style={{
            backgroundColor: "var(--bg-secondary)",
            color: "var(--text-primary)",
          }}
          aria-label="Back to App Store">
          <ChevronLeft className="w-5 h-5" />
        </button>

        {/* Header - Desktop Layout */}
        <div className="mb-8">
          <div className="flex items-start gap-6 mb-6">
            {/* Left Side - App Info (takes more space on desktop) */}
            <div className="flex-1 min-w-0">
              {/* App Title */}
              <h1
                className="text-[40px] leading-tight mb-[32px] font-bold"
                style={{
                  fontFamily: '"Red Hat Display", sans-serif',
                  color: "var(--text-primary)",
                }}>
                {app.name}
              </h1>

              {/* Company Name • App Type */}
              <div
                className="flex items-center gap-2 text-[20px] mb-[8px]"
                style={{
                  fontFamily: '"Red Hat Display", sans-serif',
                  color: "var(--text-primary)",
                }}>
                <span>{app.orgName || app.developerProfile?.company || "Mentra"}</span>
                <span>•</span>
                <span>{getAppTypeDisplay(app)}</span>
              </div>

              {/* Info Tags Section - Horizontal on Desktop only */}
              {APP_TAGS[app.name] && (
                <div className="flex items-center gap-2 mb-[32px] flex-wrap">
                  {APP_TAGS[app.name].map((tag, index) => (
                    <div
                      key={index}
                      className="px-3 py-1.5 rounded-full text-[14px] font-normal"
                      style={{
                        backgroundColor: "var(--bg-secondary)",
                        color: "var(--text-secondary)",
                        fontFamily: '"Red Hat Display", sans-serif',
                      }}>
                      {tag}
                    </div>
                  ))}
                </div>
              )}

              {/* Buttons Section - Desktop only */}
              <div className="flex items-center gap-[24px] relative z-0">
                {/* Install Button */}
                {isAuthenticated ? (
                  app.isInstalled ? (
                    <Button
                      disabled={true}
                      className="px-8 h-[44px] text-[20px] font-medium rounded-full opacity-40 cursor-not-allowed min-w-[242px]"
                      style={{
                        fontFamily: '"Red Hat Display", sans-serif',
                        backgroundColor: "var(--button-bg)",
                        color: "var(--button-text)",
                      }}>
                      Installed
                    </Button>
                  ) : (
                    <Button
                      onClick={handleInstall}
                      disabled={installingApp}
                      className="px-8 h-[44px] text-[18px] font-medium rounded-full transition-all min-w-[242px]"
                      style={{
                        fontFamily: '"Red Hat Display", sans-serif',
                        backgroundColor: "var(--button-bg)",
                        color: "var(--button-text)",
                      }}>
                      {installingApp ? "Getting…" : "Get"}
                    </Button>
                  )
                ) : (
                  <Button
                    onClick={navigateToLogin}
                    className="px-8 h-[44px] text-[20px] font-medium rounded-full transition-all min-w-[242px]"
                    style={{
                      fontFamily: '"Red Hat Display", sans-serif',
                      backgroundColor: "var(--button-bg)",
                      color: "var(--button-text)",
                    }}>
                    Get
                  </Button>
                )}

                {/* Share Button */}
                <button
                  className="w-[113px] flex items-center gap-2 px-5 h-[44px] rounded-full transition-colors bg-[var(--share-button)] border-[var(--border-btn)] border-[1px]"
                  style={{
                    borderColor: "var(--border-color)",
                    color: "var(--text-primary)",
                    fontFamily: '"Red Hat Display", sans-serif',
                  }}
                  onClick={() => {
                    if (navigator.share) {
                      navigator.share({
                        title: app.name,
                        text: app.description || `Check out ${app.name}`,
                        url: window.location.href,
                      });
                    }
                  }}>
                  <Share2 className="w-[18px] h-[18px] bg-[var(--share-button)] border-[var(--border-btn)]" />
                  <span className="text-[18px] font-medium">Share</span>
                </button>
              </div>

              {/* Device Compatibility Notice - Desktop only */}
              <div
                className="flex items-center gap-2 text-[14px] mt-[32px]"
                style={{
                  color: "var(--text-secondary)",
                  fontFamily: '"Red Hat Display", sans-serif',
                }}>
                <Smartphone className="w-[18px] h-[18px] text-[14px]" />
                <span>This app is available for your device</span>
              </div>
            </div>

            {/* Right Side - App Icon (desktop only, larger) */}
            <div className="flex-shrink-0">
              <img
                src={app.logoURL}
                alt={`${app.name} logo`}
                className="w-[220px] h-[220px] object-cover rounded-[60px] shadow-md"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = "https://placehold.co/140x140/gray/white?text=App";
                }}
              />
            </div>
          </div>
        </div>

        {/* Offline Warning */}
        {app.isOnline === false && (
          <div className="mb-6">
            <div
              className="flex items-center p-3 rounded-lg"
              style={{
                backgroundColor: "var(--error-bg)",
                border: "1px solid var(--error-color)",
              }}>
              <Info
                className="h-5 w-5"
                style={{
                  color: "var(--error-color)",
                }}
              />
              <span
                className="text-[14px]"
                style={{
                  color: "var(--error-color)",
                }}>
                This app appears to be offline. Some actions may not work.
              </span>
            </div>
          </div>
        )}

        <div className="h-[1px] w-full bg-[var(--border)] mb-[24px] mt-[24px]"></div>

        {/* Vertical Scrollable Layout - All sections visible */}
        <div className="">
          {/* About this app Section */}
          <div className="">
            <h2
              className="text-[24px] font-semibold mb-[24px]"
              style={{
                fontFamily: '"Red Hat Display", sans-serif',
                color: "var(--text-primary)",
              }}>
              About this app
            </h2>

            {/* Preview Images Carousel */}
            {app.previewImages && app.previewImages.length > 0 && (
              <div className="mb-8  z-1">
                <div
                  className="flex gap-4 overflow-x-auto pb-4 snap-x snap-mandatory"
                  style={{
                    scrollbarWidth: "none",
                    msOverflowStyle: "none",
                  }}>
                  {app.previewImages
                    .sort((a, b) => a.order - b.order)
                    .map((image, index) => {
                      const isPortrait = image.orientation === "portrait";
                      const imageKey = image.imageId || `${image.url}-${index}`;
                      const isLoaded = loadedImages.has(imageKey);

                      return (
                        <div
                          key={imageKey}
                          className=" flex-shrink-0 rounded-lg overflow-hidden snap-start cursor-pointer transition-opacity relative"
                          style={{
                            maxHeight: "422px",
                            height: "422px",
                            width: isPortrait ? "195px" : "750px", // Portrait: 195:422 ratio, Landscape: 16:9 ratio
                            backgroundColor: "var(--bg-secondary)",
                          }}
                          onClick={() => setSelectedImage({ url: image.url, index })}>
                          {/* Skeleton Loader */}
                          {!isLoaded && (
                            <div
                              className="absolute inset-0 animate-pulse"
                              style={{
                                backgroundColor: "var(--bg-secondary)",
                              }}>
                              <div
                                className="w-full h-full"
                                style={{
                                  background:
                                    "linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent)",
                                  backgroundSize: "200% 100%",
                                  animation: "shimmer 1.5s infinite",
                                }}
                              />
                            </div>
                          )}

                          <img
                            src={image.url}
                            alt={`${app.name} preview ${index + 1}`}
                            className="w-full h-full object-cover"
                            style={{
                              objectPosition: "center",
                              opacity: isLoaded ? 1 : 0,
                              transition: "opacity 0.3s ease-in-out",
                            }}
                            onLoad={() => {
                              setLoadedImages((prev) => new Set(prev).add(imageKey));
                            }}
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = "none";
                              setLoadedImages((prev) => new Set(prev).add(imageKey));
                            }}
                          />
                        </div>
                      );
                    })}
                </div>
                <style
                  dangerouslySetInnerHTML={{
                    __html: `
                    .overflow-x-auto::-webkit-scrollbar {
                      display: none;
                    }
                    @keyframes shimmer {
                      0% {
                        background-position: -200% 0;
                      }
                      100% {
                        background-position: 200% 0;
                      }
                    }
                  `,
                  }}
                />
              </div>
            )}

            <p
              className="text-[20px] font-normal leading-[1.6]"
              style={{
                fontFamily: '"Red Hat Display", sans-serif',
                color: "var(--text-primary)",
              }}>
              {app.description || "No description available."}
            </p>
          </div>

          <div className="h-[1px] w-full bg-[var(--border)] mb-[24px] mt-[24px]"></div>

          {/* Permission Section */}
          <div>
            <h2
              className="text-[24px] font-semibold mb-[24px]"
              style={{
                fontFamily: '"Red Hat Display", sans-serif',
                color: "var(--text-primary)",
              }}>
              Permission
            </h2>
            <p
              className="text-[20px] mb-6 leading-[1.6]"
              style={{
                fontFamily: '"Red Hat Display", sans-serif',
                color: "var(--text-secondary)",
              }}>
              Permissions that will be requested when using this app on your phone.
            </p>
            <div className="space-y-3">
              {app.permissions && app.permissions.length > 0 ? (
                app.permissions.map((permission, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-[24px] rounded-[16px] h-[74px]"
                    style={{
                      backgroundColor: "var(--primaary-foreground)",
                    }}>
                    <div className="flex items-center gap-[16px]">
                      <div>
                        <div
                          style={{
                            color: "var(--text-secondary)",
                          }}
                          className="w-[24px] h-[24px]">
                          {getPermissionIcon(permission.type || "Display")}
                        </div>
                      </div>
                      <div
                        className="text-[20px] font-medium"
                        style={{
                          fontFamily: '"Red Hat Display", sans-serif',
                          color: "var(--text-primary)",
                        }}>
                        {(permission.type || "Display").charAt(0).toUpperCase() +
                          (permission.type || "Display").slice(1).toLowerCase()}
                      </div>
                    </div>
                    <div
                      className="text-[20px] text-right max-w-[50%]"
                      style={{
                        fontFamily: '"Red Hat Display", sans-serif',
                        color: "var(--text-secondary)",
                      }}>
                      {permission.description || getPermissionDescription(permission.type || "Display")}
                    </div>
                  </div>
                ))
              ) : (
                <div
                  className="text-center py-8 rounded-xl"
                  style={{
                    backgroundColor: "var(--primaary-foreground)",
                    border: "1px solid var(--border-color)",
                  }}>
                  <div
                    className="text-[20px] font-medium"
                    style={{
                      color: "var(--text-secondary)",
                    }}>
                    No special permissions required
                  </div>
                  <div
                    className="text-[13px] mt-2"
                    style={{
                      color: "var(--text-secondary)",
                    }}>
                    This app runs with standard system permissions only.
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="h-[1px] w-full bg-[var(--border)] mb-[24px] mt-[24px]"></div>

          {/* Hardware Section */}
          <div>
            <h2
              className="text-[24px] font-semibold mb-[24px]"
              style={{
                fontFamily: '"Red Hat Display", sans-serif',
                color: "var(--text-primary)",
              }}>
              Hardware
            </h2>
            <p
              className="text-[15px] mb-6 leading-[1.6]"
              style={{
                fontFamily: '"Red Hat Display", sans-serif',
                color: "var(--text-secondary)",
              }}>
              Hardware components required or recommended for this app.
            </p>
            <div className="space-y-3">
              {app.hardwareRequirements && app.hardwareRequirements.length > 0 ? (
                app.hardwareRequirements.map((req, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-[24px] rounded-[16px] h-[74px]"
                    style={{
                      backgroundColor: "var(--primaary-foreground)",
                    }}>
                    <div className="flex items-center gap-[16px]">
                      <div className="">
                        <div
                          style={{
                            color: "var(--text-secondary)",
                          }}>
                          {hardwareIcons[req.type as HardwareType]}
                        </div>
                      </div>
                      <div
                        className="text-[20px] font-medium"
                        style={{
                          fontFamily: '"Red Hat Display", sans-serif',
                          color: "var(--text-primary)",
                        }}>
                        {req.type.charAt(0).toUpperCase() + req.type.slice(1).toLowerCase()}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      {req.level && (
                        <div
                          className="text-[20px] font-medium"
                          style={{
                            color:
                              req.level === HardwareRequirementLevel.REQUIRED
                                ? "var(--warning-text)"
                                : "var(--text-secondary)",
                          }}>
                          {req.level === HardwareRequirementLevel.REQUIRED ? "Required" : "Optional"}
                        </div>
                      )}
                      {req.description && (
                        <div
                          className="text-[20px] text-right"
                          style={{
                            fontFamily: '"Red Hat Display", sans-serif',
                            color: "var(--text-secondary)",
                          }}>
                          {req.description}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div
                  className="text-center py-8 rounded-xl"
                  style={{
                    backgroundColor: "var(--primaary-foreground)",
                    border: "1px solid var(--border-color)",
                  }}>
                  <div
                    className="text-[20px] font-medium"
                    style={{
                      color: "var(--text-secondary)",
                    }}>
                    No specific hardware requirements
                  </div>
                  <div
                    className="text-[13px] mt-2"
                    style={{
                      color: "var(--text-secondary)",
                    }}>
                    This app works with any glasses configuration.
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="h-[1px] w-full bg-[var(--border)] mb-[24px] mt-[24px]"></div>

          {/* Contact Section */}
          <div>
            <h2
              className="text-[24px] font-semibold mb-[24px]"
              style={{
                fontFamily: '"Red Hat Display", sans-serif',
                color: "var(--text-primary)",
              }}>
              Contact
            </h2>
            <p
              className="text-[20px] mb-[24px] leading-[1.6]"
              style={{
                fontFamily: '"Red Hat Display", sans-serif',
                color: "var(--text-secondary)",
              }}>
              Get in touch with the developer or learn more about this app.
            </p>
            <div className="flex justify-between gap-y-6 flex-wrap">
              <div className="flex flex-col">
                <span
                  className="text-[20px] font-medium mb-2"
                  style={{
                    color: "var(--text-secondary)",
                  }}>
                  Company
                </span>
                <span
                  className="text-[20px] font-normal"
                  style={{
                    color: "var(--text-primary)",
                  }}>
                  {app.orgName || app.developerProfile?.company || "Mentra"}
                </span>
              </div>

              <div className="flex flex-col">
                <span
                  className="text-[20px] font-medium mb-2"
                  style={{
                    color: "var(--text-secondary)",
                  }}>
                  Package Name
                </span>
                <span
                  className="text-[20px] font-normal hover:underline"
                  style={{
                    color: "var(--accent-primary)",
                  }}>
                  {app.packageName}
                </span>
              </div>

              {app.developerProfile?.website && (
                <div className="flex flex-col">
                  <span
                    className="text-[20px] font-medium mb-2"
                    style={{
                      color: "var(--text-secondary)",
                    }}>
                    Website
                  </span>
                  <a
                    href={app.developerProfile.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[20px] font-normal hover:underline"
                    style={{
                      color: "var(--accent-primary)",
                    }}>
                    {app.developerProfile.website}
                  </a>
                </div>
              )}

              {app.developerProfile?.contactEmail && (
                <div className="flex flex-col">
                  <span
                    className="text-[20px] font-medium mb-2"
                    style={{
                      color: "var(--text-secondary)",
                    }}>
                    Contact
                  </span>
                  <a
                    href={`mailto:${app.developerProfile.contactEmail}`}
                    className="text-[20px] font-normal hover:underline"
                    style={{
                      color: "var(--accent-primary)",
                    }}>
                    {app.developerProfile.contactEmail}
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Get MentraOS - Hide in React Native WebView */}
        {!isWebView && (
          <div className="text-center mb-8 mt-12">
            {/* <div className="flex justify-center">
              <GetMentraOSButton size="small" />
            </div> */}
          </div>
        )}
      </div>

      {/* Image Modal */}
      {selectedImage && app.previewImages && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setSelectedImage(null)}>
          <button
            onClick={() => setSelectedImage(null)}
            className="absolute top-6 right-6 p-2 rounded-full transition-colors hover:bg-white/10"
            style={{ color: "white" }}
            aria-label="Close">
            <X className="h-6 w-6" />
          </button>

          {/* Previous Button */}
          {selectedImage.index > 0 && app.previewImages && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const prevIndex = selectedImage.index - 1;
                const sortedImages = app.previewImages ? [...app.previewImages].sort((a, b) => a.order - b.order) : [];
                setSelectedImage({ url: sortedImages[prevIndex].url, index: prevIndex });
              }}
              className="absolute left-6 p-3 rounded-full transition-colors hover:bg-white/10"
              style={{ color: "white" }}
              aria-label="Previous image">
              <ChevronLeft className="h-8 w-8" />
            </button>
          )}

          {/* Next Button */}
          {app.previewImages && selectedImage.index < app.previewImages.length - 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const nextIndex = selectedImage.index + 1;
                const sortedImages = app.previewImages ? [...app.previewImages].sort((a, b) => a.order - b.order) : [];
                setSelectedImage({ url: sortedImages[nextIndex].url, index: nextIndex });
              }}
              className="absolute right-6 p-3 rounded-full transition-colors hover:bg-white/10"
              style={{ color: "white" }}
              aria-label="Next image">
              <ChevronRight className="h-8 w-8" />
            </button>
          )}

          <div
            className="relative flex items-center justify-center"
            style={{
              maxWidth: "90vw",
              maxHeight: "90vh",
            }}>
            <img
              src={selectedImage.url}
              alt={`${app.name} preview ${selectedImage.index + 1}`}
              style={{
                maxWidth: "90vw",
                maxHeight: "90vh",
                width: "auto",
                height: "auto",
              }}
              className="object-contain rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default AppDetailsDesktop;
