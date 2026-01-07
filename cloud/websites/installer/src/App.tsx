import {useEffect, type FC} from "react"
import {BrowserRouter, Routes, Route, Navigate} from "react-router-dom"
import InstallGuide from "./pages/InstallGuide"
import {generateManifest} from "./manifest"

const App: FC = () => {
  useEffect(() => {
    // Get redirect URL from query parameter
    const params = new URLSearchParams(window.location.search)
    const redirectUrl = params.get("url")

    // Update manifest dynamically
    const manifest = generateManifest(redirectUrl || undefined)
    const manifestBlob = new Blob([JSON.stringify(manifest)], {type: "application/json"})
    const manifestUrl = URL.createObjectURL(manifestBlob)

    // Update the manifest link
    let manifestLink = document.querySelector('link[rel="manifest"]') as HTMLLinkElement
    if (!manifestLink) {
      manifestLink = document.createElement("link")
      manifestLink.rel = "manifest"
      document.head.appendChild(manifestLink)
    }
    manifestLink.href = manifestUrl

    // Check if running as installed PWA and redirect
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    if (isStandalone && redirectUrl) {
      try {
        // Validate URL format
        new URL(redirectUrl)
        window.location.href = redirectUrl
      } catch (e) {
        console.error("Invalid redirect URL:", redirectUrl)
      }
    }
  }, [])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<InstallGuide />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
