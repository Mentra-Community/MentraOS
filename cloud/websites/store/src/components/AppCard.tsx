import {memo, useState} from "react"
import {Button} from "./ui/button"
import {AppI} from "../types"

// Tag mapping for apps
const APP_TAGS: Record<string, string[]> = {
  "X": ["Social", "News", "Media"],
  "Merge": ["Chat", "Social"],
  "Live Captions": ["Language", "Communication"],
  "Streamer": ["Video", "Broadcast"],
  "Translation": ["Language", "Communication"],
  "LinkLingo": ["Language", "Learning"],
  "Mentra Notes": ["Tools"],
  "Dash": ["Fitness", "Running"],
  "Calendar": ["Time", "Schedule"],
  "Teleprompter": ["Media", "Tools"],
  "MemCards": ["Learning", "Memory"],
}

// Fallback tags for apps without specific tags
const FALLBACK_TAGS = ["App", "Utility"]

interface AppCardProps {
  app: AppI
  theme: string
  isAuthenticated: boolean
  // isWebView: boolean; // Deprecated: No longer used after removing Open button
  installingApp: string | null
  onInstall: (packageName: string) => void
  onUninstall: (packageName: string) => void
  // onOpen: (packageName: string) => void; // Deprecated: No longer used after removing Open button
  onCardClick: (packageName: string) => void
  onLogin: () => void
  isLastRow?: boolean
}

const AppCard: React.FC<AppCardProps> = memo(
  ({
    app,
    theme,
    isAuthenticated,
    // isWebView, // Deprecated: No longer used after removing Open button
    installingApp,
    onInstall,
    // onOpen, // Deprecated: No longer used after removing Open button
    onCardClick,
    onLogin,
    isLastRow = false,
  }) => {
    const [imageLoaded, setImageLoaded] = useState(false)
    const [imageError, setImageError] = useState(false)

    const handleCardClick = () => {
      onCardClick(app.packageName)
    }

    const handleInstallClick = (e: React.MouseEvent) => {
      e.stopPropagation()
      onInstall(app.packageName)
    }

    // Deprecated: No longer used after removing Open button
    // const handleOpenClick = (e: React.MouseEvent) => {
    //   e.stopPropagation();
    //   onOpen(app.packageName);
    // };

    const handleLoginClick = (e: React.MouseEvent) => {
      e.stopPropagation()
      onLogin()
    }

    const handleImageLoad = () => {
      setImageLoaded(true)
    }

    const handleImageError = () => {
      setImageError(true)
      setImageLoaded(true)
    }

    return (
      <div
        className="  flex gap-2 sm:gap-3 rounded-sm relative cursor-pointer "
        data-app-card
        onClick={handleCardClick}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-secondary)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}>
        {!isLastRow && (
          <div className="absolute -bottom-[12px] left-1/2 -translate-x-1/2 h-px w-[100%] bg-[var(--border)]"></div>
        )}

        {/* Image Column */}
        <div className="shrink-0 flex items-start">
          <div className="relative w-14 h-14 sm:w-16 sm:h-16">
            {/* Placeholder that shows immediately */}
            <div
              className={`absolute inset-0 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center transition-opacity duration-200 ${
                imageLoaded ? "opacity-0" : "opacity-100"
              }`}>
              <div className="w-6 h-6 bg-gray-300 dark:bg-gray-600 rounded-full animate-pulse"></div>
            </div>

            {/* Actual image that loads in background */}
            <img
              src={imageError ? "https://placehold.co/48x48/gray/white?text=App" : app.logoURL}
              alt={`${app.name} logo`}
              className={`w-14 h-14 sm:w-16 sm:h-16 object-cover rounded-2xl transition-opacity duration-200 ${
                imageLoaded ? "opacity-100" : "opacity-0"
              }`}
              loading="lazy"
              decoding="async"
              onLoad={handleImageLoad}
              onError={handleImageError}
            />
          </div>
        </div>

        {/* Content Column */}
        <div className="flex-1 flex flex-col justify-center min-w-0">
          <div>
            <h3
              className="leading-tight text-[16px] sm:text-[16px]  truncate font-semibold text-[var(--secondary-foreground)]"
              style={{
                fontFamily: '"Red Hat Display", sans-serif',
                letterSpacing: "0.04em",
                color: "var(--text-primary)",
              }}>
              {app.name}
            </h3>

            {/* Tags */}
            <div className=" mt-[1px] mb-[6px] leading-tight flex gap-1 flex-wrap items-center font-semibold text-[12px] text-[var(--secondary-foreground)]">
              {(APP_TAGS[app.name] || FALLBACK_TAGS).map((tag, index) => (
                <span key={tag} className="flex items-center gap-1">
                  <span
                    className="text-[11px] sm:text-[13px] font-medium -mb-[4px]"
                    style={{
                      fontFamily: '"Red Hat Display", sans-serif',
                      letterSpacing: "0.02em",
                    }}>
                    {tag}
                  </span>
                  {index < (APP_TAGS[app.name] || FALLBACK_TAGS).length - 1 && (
                    <span
                      className="w-0.5 h-0.5 rounded-full -mb-1"
                      style={{
                        background: theme === "light" ? "#9E9E9E" : "#666666",
                      }}></span>
                  )}
                </span>
              ))}
            </div>

            {app.description && (
              <p
                className="leading-normal text-[10px] font-normal break-words text-[var(--muted-foreground)]"
                style={{
                  fontFamily: '"Red Hat Display", sans-serif',
                  letterSpacing: "0.04em",
                  color: theme === "light" ? "#4a4a4a" : "#9A9CAC",
                  WebkitLineClamp: 1,
                  display: "-webkit-box",
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  wordBreak: "break-word",
                  overflowWrap: "break-word",
                }}>
                {app.description}
              </p>
            )}
          </div>
        </div>

        {/* Button Column */}
        <div className="shrink-0 flex items-center">
          {isAuthenticated ? (
            app.isInstalled ? (
              // Deprecated: Open button functionality
              // isWebView ? (
              //   <Button
              //     onClick={handleOpenClick}
              //     disabled={installingApp === app.packageName}
              //     className="text-[11px] font-normal tracking-[0.1em] px-4 py-[6px] rounded-full w-fit h-fit cursor-not-allowed bg-white text-black"
              //     style={{
              //       backgroundColor: "var(--button-bg)",
              //       color: "var(--button-text)",
              //     }}
              //     onMouseEnter={(e) =>
              //       (e.currentTarget.style.backgroundColor =
              //         "var(--button-hover)")
              //     }
              //     onMouseLeave={(e) =>
              //       (e.currentTarget.style.backgroundColor = "var(--button-bg)")
              //     }
              //   >
              //     Open
              //   </Button>
              // ) : (
              <Button
                disabled={true}
                className="font-normal tracking-[0.1em] px-4 py-[6px] rounded-full opacity-30 cursor-not-allowed bg-[var(--muted-foreground)] text-[var(--primaary-foreground)] flex items-center justify-center h-[36px] w-[85px] text-[14px]"
                style={
                  {
                    // backgroundColor: "var(--button-bg)",
                    // color: "var(--button-text)",
                    // filter: "grayscale(100%)",
                  }
                }>
                <div className="text-[14px]">Installed</div>
              </Button>
            ) : (
              // )
              <Button
                onClick={handleInstallClick}
                disabled={installingApp === app.packageName}
                className=" text-[11px] font-normal tracking-[0.1em] px-4 py-[6px] rounded-full w-[56px] h-[36px] flex items-center justify-center"
                style={{
                  backgroundColor: "var(--button-bg)",
                  color: "var(--button-text)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--button-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--button-bg)")}>
                {installingApp === app.packageName ? (
                  <div
                    className="animate-spin h-4 w-4 border-2 border-t-transparent rounded-full"
                    style={{
                      borderColor: "var(--button-text)",
                      borderTopColor: "transparent",
                    }}></div>
                ) : (
                  <div className="text-[14px]  font-medium">Get</div>
                )}
              </Button>
            )
          ) : (
            <Button
              onClick={handleLoginClick}
              className="text-[15px] font-normal tracking-[0.1em] px-4 py-[6px] rounded-full w-fit h-fit flex items-center gap-2"
              style={{
                backgroundColor: "var(--button-bg)",
                color: "var(--button-text)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--button-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--button-bg)")}>
              <div className="text-[11px] font-bold">Get</div>
              {/* <Lock className="h-4 w-4 mr-1" /> */}
            </Button>
          )}
        </div>
      </div>
    )
  },
)

AppCard.displayName = "AppCard"

export default AppCard
