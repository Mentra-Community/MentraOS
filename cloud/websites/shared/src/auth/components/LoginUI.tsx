import {useState, useEffect} from "react"
import {Button} from "./ui/button"
import {Spinner} from "./ui/spinner"
import EmailAuthModal from "./EmailAuthModal"
import {FcGoogle} from "react-icons/fc"
import {FaApple} from "react-icons/fa"
import {FiAlertCircle, FiMail} from "react-icons/fi"
import {mentraAuthProvider} from "../utils/auth/authProvider"
import {IMAGES} from "../../constants/images"

const IS_CHINA = (import.meta.env.VITE_DEPLOYMENT_REGION || "global") === "china"

interface LoginUIProps {
  /** Logo image URL */
  logoUrl?: string
  /** Site name to display below logo (e.g., "Developer Portal") */
  siteName: string
  /** Optional message to display (e.g., for invites) */
  message?: string
  /** Redirect path after successful authentication */
  redirectTo: string
  /** Email modal redirect path */
  emailRedirectPath: string
  /** Email modal open state */
  isEmailModalOpen: boolean
  /** Email modal state setter */
  setIsEmailModalOpen: (open: boolean) => void
}

export const LoginUI: React.FC<LoginUIProps> = ({
  logoUrl = IMAGES.iconOnly,
  siteName,
  message,
  redirectTo,
  emailRedirectPath,
  isEmailModalOpen,
  setIsEmailModalOpen,
}) => {
  const [isSignUp, setIsSignUp] = useState(true)
  const [isLoading, setIsLoading] = useState({
    google: false,
    apple: false,
    email: false,
  })
  const [error, setError] = useState<string | null>(null)
  const [isErrorVisible, setIsErrorVisible] = useState(false)

  useEffect(() => {
    if (error) {
      setIsErrorVisible(true)
    } else {
      setIsErrorVisible(false)
    }
  }, [error])

  const handleCloseError = () => {
    setError(null)
  }

  const handleGoogleSignIn = async () => {
    setError(null)
    try {
      setIsLoading((prev) => ({...prev, google: true}))
      const {error} = await mentraAuthProvider.googleSignIn(redirectTo)
      if (error) {
        setError(error.message || "Failed to sign in with Google")
        console.error("Google sign in error:", error)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred"
      setError(`Google sign in failed: ${errorMessage}`)
      console.error("Google sign in error:", error)
    } finally {
      setIsLoading((prev) => ({...prev, google: false}))
    }
  }

  const handleAppleSignIn = async () => {
    setError(null)
    try {
      setIsLoading((prev) => ({...prev, apple: true}))
      const {error} = await mentraAuthProvider.appleSignIn(redirectTo)
      if (error) {
        setError(error.message || "Failed to sign in with Apple")
        console.error("Apple sign in error:", error)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred"
      setError(`Apple sign in failed: ${errorMessage}`)
      console.error("Apple sign in error:", error)
    } finally {
      setIsLoading((prev) => ({...prev, apple: false}))
    }
  }

  const handleSignUp = () => {
    setIsSignUp(true)
    setIsEmailModalOpen(true)
  }

  const handleLogIn = () => {
    setIsSignUp(false)
    setIsEmailModalOpen(true)
  }

  const handleForgotPassword = () => {
    setIsEmailModalOpen(false)
    window.location.href = "/forgot-password"
  }

  return (
    <div className="min-h-screen bg-background flex flex-col w-full">
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full max-w-sm mx-auto flex flex-col items-center">
          {/* Icon */}
          <img src={logoUrl} alt="Mentra Logo" className="h-24 w-24" />

          {/* Wordmark */}
          <p className="text-[46px] text-secondary-foreground text-center pt-8 pb-4">
            Mentra
          </p>

          {/* Site name / Welcome message */}
          <p className="text-xl text-secondary-foreground text-center mb-4">
            Welcome to the Mentra {siteName}
          </p>

          {/* Invite message if present */}
          {message && (
            <p className="text-sm text-accent bg-accent/10 p-3 rounded-lg mb-6 text-center">
              {message}
            </p>
          )}

          {/* Error Message */}
          {error && (
            <div
              className={`w-full p-4 mb-4 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg transition-all duration-300 transform ${
                isErrorVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
              }`}
              role="alert">
              <div className="flex items-center">
                <FiAlertCircle className="flex-shrink-0 w-4 h-4 mr-2" />
                <span className="sr-only">Error</span>
                <div className="flex-1">{error}</div>
                <button
                  type="button"
                  className="ml-3 text-destructive hover:text-destructive/80"
                  onClick={handleCloseError}
                  aria-label="Close error message">
                  <span className="sr-only">Close</span>
                  <svg
                    className="w-4 h-4"
                    aria-hidden="true"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Buttons - stacked like mobile */}
          <div className="w-full space-y-4 mb-4">
            {/* Email button first (primary) */}
            <Button
              variant="default"
              className="w-full"
              onClick={handleSignUp}
              disabled={isLoading.email}>
              {isLoading.email ? (
                <>
                  <Spinner size="sm" />
                  Processing...
                </>
              ) : (
                <>
                  <FiMail className="w-5 h-5" />
                  Sign up with Email
                </>
              )}
            </Button>

            {/* Social buttons (secondary) */}
            {!IS_CHINA && (
              <>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={handleGoogleSignIn}
                  disabled={isLoading.google}>
                  <FcGoogle className="w-5 h-5" />
                  {isLoading.google ? "Signing in..." : "Continue with Google"}
                </Button>

                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={handleAppleSignIn}
                  disabled={isLoading.apple}>
                  <FaApple className="w-5 h-5" />
                  {isLoading.apple ? "Signing in..." : "Continue with Apple"}
                </Button>
              </>
            )}
          </div>

          {/* Log in link */}
          <div className="flex items-center justify-center gap-1 mt-2">
            <span className="text-sm text-muted-foreground">
              Already have an account?
            </span>
            <button
              type="button"
              onClick={handleLogIn}
              className="text-sm text-accent font-semibold cursor-pointer hover:underline">
              Log in
            </button>
          </div>

          {/* Terms text */}
          <p className="text-xs text-muted-foreground text-center mt-4">
            By continuing, you agree to our{" "}
            <a href="https://mentra.glass/terms-of-service" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              Terms of Service
            </a>{" "}
            and{" "}
            <a href="https://mentra.glass/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              Privacy Policy
            </a>.
          </p>
        </div>
      </main>

      {/* Email Auth Modal */}
      <EmailAuthModal
        open={isEmailModalOpen}
        onOpenChange={setIsEmailModalOpen}
        isSignUp={isSignUp}
        setIsSignUp={setIsSignUp}
        redirectPath={emailRedirectPath}
        onForgotPassword={handleForgotPassword}
      />
    </div>
  )
}
