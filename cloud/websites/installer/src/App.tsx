import {useEffect, type FC} from "react"
import {BrowserRouter, Routes, Route, Navigate} from "react-router-dom"
import InstallGuide from "./pages/InstallGuide"
import Redirect from "./pages/Redirect"
import {generateManifest} from "./manifest"

const App: FC = () => {
  useEffect(() => {
    // Get redirect URL from query parameter
    const params = new URLSearchParams(window.location.search)
    const redirectUrl = params.get("url")

    // Generate and inject dynamic manifest
    const manifest = generateManifest(redirectUrl || undefined)
    const manifestJson = JSON.stringify(manifest)
    const manifestBlob = new Blob([manifestJson], {type: "application/json"})
    const manifestURL = URL.createObjectURL(manifestBlob)

    // Update or create manifest link
    let manifestLink = document.querySelector('link[rel="manifest"]') as HTMLLinkElement
    if (!manifestLink) {
      manifestLink = document.createElement("link")
      manifestLink.rel = "manifest"
      document.head.appendChild(manifestLink)
    }
    manifestLink.href = manifestURL

    // If we have a redirect URL and are in standalone mode, redirect immediately
    if (redirectUrl) {
      // const isStandalone = window.matchMedia("(display-mode: standalone)").matches
      // if (isStandalone) {
      try {
        new URL(redirectUrl)
        window.location.href = redirectUrl
      } catch (e) {
        console.error("Invalid redirect URL:", redirectUrl)
      }
      // }
    }

    // window.alert(redirectUrl)
  }, [])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<InstallGuide />} />
        <Route path="/redirect" element={<Redirect />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
