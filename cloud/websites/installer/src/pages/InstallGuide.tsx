import {useEffect, useState, type FC} from "react"
import {Smartphone, Monitor, Share2, PlusSquare, Home, ExternalLink} from "lucide-react"
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../components/ui/card"
import {Button} from "../components/ui/button"

type Platform = "ios" | "android" | "desktop" | "unknown"

const InstallGuide: FC = () => {
  const [platform, setPlatform] = useState<Platform>("unknown")
  const [redirectUrl, setRedirectUrl] = useState<string>("")
  const [customUrl, setCustomUrl] = useState<string>("")

  useEffect(() => {
    // Detect platform
    const userAgent = navigator.userAgent.toLowerCase()
    const isIOS = /iphone|ipad|ipod/.test(userAgent)
    const isAndroid = /android/.test(userAgent)
    const isDesktop = !isIOS && !isAndroid

    if (isIOS) {
      setPlatform("ios")
    } else if (isAndroid) {
      setPlatform("android")
    } else if (isDesktop) {
      setPlatform("desktop")
    }

    // Get redirect URL from query parameter
    const params = new URLSearchParams(window.location.search)
    const urlParam = params.get("url")
    if (urlParam) {
      setRedirectUrl(urlParam)
    }
  }, [])

  const getPlatformIcon = () => {
    switch (platform) {
      case "ios":
      case "android":
        return <Smartphone className="h-8 w-8 text-[var(--accent-primary)]" />
      case "desktop":
        return <Monitor className="h-8 w-8 text-[var(--accent-primary)]" />
      default:
        return <Smartphone className="h-8 w-8 text-[var(--accent-primary)]" />
    }
  }

  const IOSInstructions = () => (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center font-semibold">
          1
        </div>
        <div className="flex-1">
          <p className="text-[var(--text-primary)] font-medium mb-2">Tap the Share button</p>
          <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm">
            <Share2 className="h-5 w-5" />
            <span>Look for the share icon at the bottom of Safari</span>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center font-semibold">
          2
        </div>
        <div className="flex-1">
          <p className="text-[var(--text-primary)] font-medium mb-2">Select "Add to Home Screen"</p>
          <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm">
            <PlusSquare className="h-5 w-5" />
            <span>Scroll down and tap "Add to Home Screen"</span>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center font-semibold">
          3
        </div>
        <div className="flex-1">
          <p className="text-[var(--text-primary)] font-medium mb-2">Tap "Add"</p>
          <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm">
            <Home className="h-5 w-5" />
            <span>Confirm to add the app to your home screen</span>
          </div>
        </div>
      </div>
    </div>
  )

  const AndroidInstructions = () => (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center font-semibold">
          1
        </div>
        <div className="flex-1">
          <p className="text-[var(--text-primary)] font-medium mb-2">Tap the menu button</p>
          <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm">
            <span>Look for the three dots menu in the top-right corner</span>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center font-semibold">
          2
        </div>
        <div className="flex-1">
          <p className="text-[var(--text-primary)] font-medium mb-2">Select "Add to Home screen" or "Install app"</p>
          <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm">
            <PlusSquare className="h-5 w-5" />
            <span>You may see "Install app" if available</span>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center font-semibold">
          3
        </div>
        <div className="flex-1">
          <p className="text-[var(--text-primary)] font-medium mb-2">Tap "Install" or "Add"</p>
          <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm">
            <Home className="h-5 w-5" />
            <span>The app will be added to your home screen</span>
          </div>
        </div>
      </div>
    </div>
  )

  const DesktopInstructions = () => (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center font-semibold">
          1
        </div>
        <div className="flex-1">
          <p className="text-[var(--text-primary)] font-medium mb-2">Look for the install icon</p>
          <div className="text-[var(--text-secondary)] text-sm">
            <p>
              In Chrome, Edge, or Brave: Look for the install icon{" "}
              <PlusSquare className="inline h-4 w-4" /> in the address bar
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center font-semibold">
          2
        </div>
        <div className="flex-1">
          <p className="text-[var(--text-primary)] font-medium mb-2">Click "Install"</p>
          <div className="text-[var(--text-secondary)] text-sm">
            <p>A popup will appear asking if you want to install the app</p>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center font-semibold">
          3
        </div>
        <div className="flex-1">
          <p className="text-[var(--text-primary)] font-medium mb-2">Confirm installation</p>
          <div className="text-[var(--text-secondary)] text-sm">
            <p>The app will open in its own window and be added to your applications</p>
          </div>
        </div>
      </div>
    </div>
  )

  const renderInstructions = () => {
    switch (platform) {
      case "ios":
        return <IOSInstructions />
      case "android":
        return <AndroidInstructions />
      case "desktop":
        return <DesktopInstructions />
      default:
        return (
          <p className="text-[var(--text-secondary)] text-center">
            Please open this page on a mobile device or supported desktop browser to see installation instructions.
          </p>
        )
    }
  }

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    let custom = "com.mentra://" + customUrl.trim()
    if (customUrl.trim()) {
      const currentUrl = window.location.origin + window.location.pathname
      const newUrl = `${currentUrl}?url=${encodeURIComponent(custom)}`
      window.location.href = newUrl
    }
  }

  return (
    <div className="min-h-screen bg-[var(--background)] py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="flex justify-center">{getPlatformIcon()}</div>
          <h1 className="text-4xl font-bold text-[var(--text-primary)]">Install MentraOS</h1>
          <p className="text-[var(--text-secondary)] text-lg">
            Add this app to your{" "}
            {platform === "desktop" ? "applications" : "home screen"} for quick and easy
            access
          </p>
        </div>

        {/* Instructions Card */}
        <Card>
          <CardHeader>
            <CardTitle>Installation Steps</CardTitle>
            <CardDescription>
              Follow these steps to install the app on your{" "}
              {platform === "ios"
                ? "iPhone or iPad"
                : platform === "android"
                  ? "Android device"
                  : "computer"}
            </CardDescription>
          </CardHeader>
          <CardContent>{renderInstructions()}</CardContent>
        </Card>

        {/* Benefits Card */}
        <Card>
          <CardHeader>
            <CardTitle>Why Install?</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-[var(--text-secondary)]">
              <li className="flex items-start gap-2">
                <span className="text-[var(--accent-primary)] mt-1">✓</span>
                <span>Quick access from your home screen or app drawer</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--accent-primary)] mt-1">✓</span>
                <span>Works offline with cached content</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--accent-primary)] mt-1">✓</span>
                <span>Full-screen experience without browser UI</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--accent-primary)] mt-1">✓</span>
                <span>Faster load times and better performance</span>
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* URL Input - Only show if no redirect URL was provided */}
        {!redirectUrl && (
          <Card>
            <CardHeader>
              <CardTitle>Set App Destination</CardTitle>
              <CardDescription>
                Enter a Mentra App URL to redirect to after installation (e.g., com.mentra.captions)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleUrlSubmit} className="space-y-4">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customUrl}
                    onChange={(e) => setCustomUrl(e.target.value)}
                    placeholder="com.mentra.captions"
                    className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                  />
                  <Button type="submit" disabled={!customUrl.trim()}>
                    Set URL
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Redirect URL Info */}
        {redirectUrl && (
          <Card>
            <CardHeader>
              <CardTitle>App Destination</CardTitle>
              <CardDescription>After installation, you'll be redirected to:</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 p-3 bg-[var(--bg-tertiary)] rounded-md">
                <ExternalLink className="h-4 w-4 text-[var(--text-muted)] flex-shrink-0" />
                <code className="text-sm text-[var(--text-primary)] break-all">{redirectUrl}</code>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Footer */}
        {/* <div className="text-center pt-4">
          <p className="text-[var(--text-muted)] text-sm">
            Need help? Visit our support page or contact us
          </p>
        </div> */}
      </div>
    </div>
  )
}

export default InstallGuide
