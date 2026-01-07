import {useEffect, useState, type FC} from "react"
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../components/ui/card"

const Redirect: FC = () => {
  const [redirectUrl, setRedirectUrl] = useState<string>("")
  const [error, setError] = useState<string>("")

  useEffect(() => {
    // Get redirect URL from localStorage
    const url = new URLSearchParams(window.location.search).get("url")

    if (url) {
      setRedirectUrl(url)

      // Attempt to redirect after a short delay
      const timer = setTimeout(() => {
        try {
          window.location.href = url
        } catch (e) {
          setError("Failed to redirect. Please try opening the app manually.")
          console.error("Redirect failed:", e)
        }
      }, 1000)

      return () => clearTimeout(timer)
    } else {
      setError("No redirect URL found. Please reinstall the app.")
    }
  }, [])

  return (
    <div className="min-h-screen bg-[var(--background)] py-8 px-4 flex items-center justify-center">
      <div className="max-w-md w-full">
        <Card>
          <CardHeader>
            <CardTitle>Redirecting...</CardTitle>
            <CardDescription>
              {redirectUrl
                ? "Taking you to your app"
                : "Setting up your app"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {redirectUrl && (
              <div className="space-y-2">
                <p className="text-[var(--text-secondary)] text-sm">Redirecting to:</p>
                <code className="block p-3 bg-[var(--bg-tertiary)] rounded-md text-sm text-[var(--text-primary)] break-all">
                  {redirectUrl}
                </code>
              </div>
            )}

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-md">
                <p className="text-red-500 text-sm">{error}</p>
              </div>
            )}

            {!error && redirectUrl && (
              <div className="flex justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-primary)]" />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default Redirect
