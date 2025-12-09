import {ChevronLeft, Info, Share2} from "lucide-react"
import {Button} from "@/components/ui/button"
import {toast} from "sonner"
import {motion, AnimatePresence} from "framer-motion"
import {useProfileDropdown} from "../contexts/ProfileDropdownContext"
import GetMentraOSButton from "../components/GetMentraOSButton"
import {HardwareRequirementLevel, HardwareType} from "../types"
import {
  APP_TAGS,
  hardwareIcons,
  getPermissionIcon,
  getPermissionDescription,
  getAppTypeDisplay,
  AppDetailsMobileProps,
} from "./AppDetailsShared"
import {ProfileDropdown} from "../components/ProfileDropdown"

const AppDetailsMobile: React.FC<AppDetailsMobileProps> = ({
  app,
  isAuthenticated,
  isWebView,
  installingApp,
  handleBackNavigation,
  handleInstall,
  navigateToLogin,
}) => {
  const profileDropdown = useProfileDropdown()

  return (
    <>
      {/* Profile dropdown - only show on mobile non-webview when authenticated */}
      {!isWebView && isAuthenticated && (
        <AnimatePresence>
          {profileDropdown.isOpen && (
            <>
              {/* Backdrop */}
              <motion.div
                initial={{opacity: 0}}
                animate={{opacity: 1}}
                exit={{opacity: 0}}
                transition={{duration: 0.2}}
                className="fixed inset-0 bg-black/20 z-40"
                onClick={() => profileDropdown.setIsOpen(false)}
              />

              {/* Dropdown Content */}
              <motion.div
                initial={{opacity: 0, y: -10}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: -10}}
                transition={{duration: 0.2}}
                className="fixed top-[85px] left-[24px] right-[24px] z-50">
                <ProfileDropdown variant="mobile" />
              </motion.div>
            </>
          )}
        </AnimatePresence>
      )}

      <div className={isWebView ? "px-6 py-6 pb-safe w-full" : "px-6 pv-6  pb-safe w-full"}>
        <div className="max-w-2xl mx-auto">
          {/* Back Button */}
          <button
            onClick={handleBackNavigation}
            className="flex items-center justify-center w-[40px] h-[40px] rounded-full mb-[24px] transition-all"
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text-primary)",
            }}
            aria-label="Back to App Store">
            <ChevronLeft className="w-5 h-5" />
          </button>

          {/* Header - Mobile Layout */}
          <div className="mb-6">
            <div className="flex items-start gap-4 mb-6">
              {/* App Icon - Mobile */}
              <div className="flex-shrink-0">
                <img
                  src={app.logoURL}
                  alt={`${app.name} logo`}
                  className="w-[80px] h-[80px] object-cover rounded-[24px] shadow-md"
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).src = "https://placehold.co/100x100/gray/white?text=App"
                  }}
                />
              </div>

              {/* App Info - Mobile */}
              <div className="flex-1 min-w-0">
                {/* App Title */}
                <h1
                  className="text-[20px]  leading-tight mb-[8px] font-semibold"
                  style={{
                    fontFamily: '"Red Hat Display", sans-serif',
                    color: "var(--text-primary)",
                  }}>
                  {app.name}
                </h1>

                {/* Company Name • App Type */}
                <div
                  className="text-[12px] mb-[8px] leading-tight"
                  style={{
                    fontFamily: '"Red Hat Display", sans-serif',
                    color: "var(--secondary-foreground)",
                  }}>
                  {app.orgName || app.developerProfile?.company || "Mentra"} • {getAppTypeDisplay(app)}
                </div>

                {/* Tag Pills */}
                {APP_TAGS[app.name] && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {APP_TAGS[app.name].slice(0, 2).map((tag, index) => (
                      <div
                        key={index}
                        className="max-h-[24px] px-3 py-1 rounded-full text-[12px] font-normal leading-tight border-[1px] border-[var(--border-btn)]"
                        style={{
                          fontFamily: '"Red Hat Display", sans-serif',
                          backgroundColor: "var(--bg-secondary)",
                          color: "var(--text-secondary)",
                        }}>
                        {tag}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Buttons Section */}
            <div className="flex items-center mb-[24px] gap-2">
              {/* Get/Install Button */}
              {isAuthenticated ? (
                app.isInstalled ? (
                  <Button
                    disabled={true}
                    className="flex-1 h-[36px] text-[14px] font-medium rounded-full opacity-40 cursor-not-allowed"
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
                    className="flex-1 h-[36px] text-[14px] font-medium rounded-full transition-all"
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
                  className="flex-1 h-[36px] text-[14px] font-medium rounded-full transition-all"
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
                className="min-w-[93px] h-[36px] flex items-center justify-center rounded-full border transition-colors  gap-1 text-[14px] bg-[var(--share-button)] border-[var(--border-btn)]"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(window.location.href)
                    toast.success("Copied link")
                  } catch {
                    toast.error("Failed to copy link")
                  }
                }}>
                <Share2 className="w-[14px] h-[14px] bg-[var(--share-button)] border-[var(--border-btn)]" />
                Share
              </button>
            </div>

            {/* About this app Section */}
            <div className="mb-6">
              <h2
                className="text-[16px] font-semibold mb-[8px]"
                style={{
                  fontFamily: '"Red Hat Display", sans-serif',
                  color: "var(--text-primary)",
                }}>
                About this app
              </h2>
              <p
                className="text-[14px] font-normal leading-[1.6]"
                style={{
                  fontFamily: '"Red Hat Display", sans-serif',
                  color: "var(--text-secondary)",
                }}>
                {app.description || "No description available."}
              </p>
            </div>
          </div>

          {/* Offline Warning */}
          {app.isOnline === false && (
            <div className="mb-6">
              <div
                className="flex items-center  p-3 rounded-lg"
                style={{
                  backgroundColor: "var(--error-bg, #fef2f2)",
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

          {/* All Sections Visible - No Dropdowns */}
          <div className="space-y-8">
            <div className="h-[1px] w-full bg-[var(--border)]"></div>

            {/* Permissions Section */}
            <div>
              <h2
                className="text-[16px] font-semibold mb-[8px]"
                style={{
                  fontFamily: '"Red Hat Display", sans-serif',
                  color: "var(--text-primary)",
                }}>
                Permissions
              </h2>
              <p
                className="text-[14px] mb-[8px] leading-[1.6]"
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
                      className="flex items-center justify-between p-[16px] rounded-[16px]"
                      style={{
                        backgroundColor: "var(--primaary-foreground)",
                      }}>
                      <div className="flex items-center gap-[4px]">
                        <div className=" h-9 flex items-center justify-center rounded-lg " style={{}}>
                          <div
                            style={{
                              color: "var(--text-secondary)",
                            }}>
                            {getPermissionIcon(permission.type || "Display")}
                          </div>
                        </div>
                        <div
                          className="text-[14px] font-medium"
                          style={{
                            fontFamily: '"Red Hat Display", sans-serif',
                            color: "var(--text-primary)",
                          }}>
                          {(permission.type || "Display").charAt(0).toUpperCase() +
                            (permission.type || "Display").slice(1).toLowerCase()}
                        </div>
                      </div>
                      <div
                        className="text-[14px] text-right max-w-[45%]"
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
                    className="text-center py-6 rounded-lg"
                    style={{
                      backgroundColor: "var(--primaary-foreground)",
                    }}>
                    <div
                      className="text-[14px] font-medium"
                      style={{
                        color: "var(--text-primary)",
                      }}>
                      No special permissions required
                    </div>
                    <div
                      className="text-[12px] mt-1"
                      style={{
                        color: "var(--text-secondary)",
                      }}>
                      This app runs with standard system permissions only.
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="h-[1px] w-full bg-[var(--border)]"></div>

            {/* Hardware Section */}
            <div>
              <h2
                className="text-[16px] font-semibold mb-[8px]"
                style={{
                  fontFamily: '"Red Hat Display", sans-serif',
                  color: "var(--text-primary)",
                }}>
                Hardware
              </h2>
              <p
                className="text-[14px] mb-[8px] leading-[1.6]"
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
                      className="flex  justify-between p-[15px] rounded-[16px] items-center"
                      style={{
                        backgroundColor: "var(--primaary-foreground)",
                      }}>
                      <div className="flex items-center gap-[4px] ">
                        <div
                          className=" h-9 flex items-center justify-center rounded-lg"
                          style={{
                            color: "var(--text-secondary)",
                          }}>
                          {hardwareIcons[req.type]}
                        </div>
                        <div
                          className="text-[14px] font-medium"
                          style={{
                            fontFamily: '"Red Hat Display", sans-serif',
                            color: "var(--text-primary)",
                          }}>
                          {req.type.charAt(0).toUpperCase() + req.type.slice(1).toLowerCase()}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {req.level && (
                          <div
                            className="text-[13px] font-medium"
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
                            className="text-[12px] text-right"
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
                    className="text-center py-6 rounded-lg"
                    style={{
                      backgroundColor: "var(--primaary-foreground)",
                    }}>
                    <div
                      className="text-[14px] font-medium"
                      style={{
                        color: "var(--text-primary)",
                      }}>
                      No specific hardware requirements
                    </div>
                    <div
                      className="text-[12px] mt-1"
                      style={{
                        color: "var(--text-secondary)",
                      }}>
                      This app works with any glasses configuration.
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="h-[1px] w-full bg-[var(--border)]"></div>

            {/* Contact Section */}
            <div>
              <h2
                className="text-[16px] font-semibold mb-[8px]"
                style={{
                  fontFamily: '"Red Hat Display", sans-serif',
                  color: "var(--text-primary)",
                }}>
                Contact
              </h2>
              <p
                className="text-[14px] mb-[8px] leading-[1.6]"
                style={{
                  fontFamily: '"Red Hat Display", sans-serif',
                  color: "var(--text-secondary)",
                }}>
                Get in touch with the developer or learn more about this app.
              </p>
              <div className="space-y-3">
                <div className="flex justify-between items-center mb-[16px]">
                  <span
                    className="text-[14px] font-medium"
                    style={{
                      color: "var(--text-secondary)",
                    }}>
                    Company
                  </span>
                  <span
                    className="text-[14px] font-normal text-right"
                    style={{
                      color: "var(--text-primary)",
                    }}>
                    {app.orgName || app.developerProfile?.company || "Mentra"}
                  </span>
                </div>

                <div className="flex justify-between items-center mb-[16px]">
                  <span
                    className="text-[14px] font-medium"
                    style={{
                      color: "var(--text-secondary)",
                    }}>
                    Package Name
                  </span>
                  <span
                    className="text-[14px] font-normal hover:underline text-right"
                    style={{
                      color: "var(--secondary-foreground)",
                    }}>
                    {app.packageName}
                  </span>
                </div>

                {app.developerProfile?.website && (
                  <div className="flex justify-between items-center mb-[16px] ">
                    <span
                      className="text-[14px] font-medium"
                      style={{
                        color: "var(--text-secondary)",
                      }}>
                      Website
                    </span>
                    <a
                      href={app.developerProfile.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[14px] font-normal hover:underline text-right"
                      style={{
                        color: "var(--secondary-foreground)",
                      }}>
                      {app.developerProfile.website}
                    </a>
                  </div>
                )}

                {app.developerProfile?.contactEmail && (
                  <div className="flex justify-between items-center mb-[16px]">
                    <span
                      className="text-[14px] font-medium"
                      style={{
                        color: "var(--text-secondary)",
                      }}>
                      Contact
                    </span>
                    <a
                      href={`mailto:${app.developerProfile.contactEmail}`}
                      className="text-[14px] font-normal hover:underline text-right"
                      style={{
                        color: "var(--secondary-foreground)",
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
              <div className="flex justify-center">
                <GetMentraOSButton size="small" />
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default AppDetailsMobile
