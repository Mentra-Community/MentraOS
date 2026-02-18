import {useState, useEffect} from "react"
import {Button} from "../components/ui/button"
import EmailAuthModal from "./EmailAuthModal"
import {FcGoogle} from "react-icons/fc"
import {FaApple} from "react-icons/fa"
import {FiAlertCircle} from "react-icons/fi"
import {mentraAuthProvider} from "../utils/auth/authProvider"
// Removed toast import as we're not using it anymore

const IS_CHINA = (import.meta.env.VITE_DEPLOYMENT_REGION || "global") === "china"
interface LoginUIProps {
  /** Logo image URL */
  logoUrl?: string
  /** Site name to display below logo */
  siteName: string
  /** Optional message to display above sign-in options */
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
  logoUrl = "https://imagedelivery.net/nrc8B2Lk8UIoyW7fY8uHVg/757b23a3-9ec0-457d-2634-29e28f03fe00/verysmall",
  siteName,
  message,
  redirectTo,
  emailRedirectPath,
  isEmailModalOpen,
  setIsEmailModalOpen,
}) => {
  const [isSignUp, setIsSignUp] = useState(false)
  const [isLoading, setIsLoading] = useState({
    google: false,
    apple: false,
    email: false,
  })
  const [error, setError] = useState<string | null>(null)
  const [isErrorVisible, setIsErrorVisible] = useState(false)

  // Handle error state with animation
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

  const handleEmailSignIn = () => {
    setIsSignUp(false)
    setIsEmailModalOpen(true)
  }

  const handleForgotPassword = () => {
    setIsEmailModalOpen(false)
    window.location.href = "/forgot-password"
  }
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col" style={{width: "100%"}}>
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-8" style={{maxWidth: "100%"}}>
        <div className="w-full max-w-md mx-auto flex flex-col items-center" style={{maxWidth: "28rem"}}>
          <img src={logoUrl} alt="Mentra Logo" />

          <div className="w-full text-center mt-6 mb-6">
            <h1 className="text-2xl font-bold mb-2">Welcome to the MentraOS {siteName}</h1>
            <p className="text-sm text-gray-500 mt-1">Choose your preferred sign in method</p>
            {message && <p className="mt-4 text-sm text-blue-600 bg-blue-50 p-3 rounded-md">{message}</p>}
          </div>

          {/* --- Login Card --- */}
          <div className="w-full bg-white p-8 rounded-lg shadow-md flex flex-col items-center">
            <div className="w-full space-y-4">
              {/* Error Message */}
              {error && (
                <div
                  className={`w-full p-4 mb-4 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg transition-all duration-300 transform ${
                    isErrorVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
                  }`}
                  role="alert">
                  <div className="flex items-center">
                    <FiAlertCircle className="flex-shrink-0 w-4 h-4 mr-2" />
                    <span className="sr-only">Error</span>
                    <div className="flex-1">{error}</div>
                    <button
                      type="button"
                      className="ml-3 text-red-600 hover:text-red-800"
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

              {/* Social Provider Sign In - Hidden in China region */}
              {!IS_CHINA && (
                <>
                  <div className="w-full space-y-3">
                    <Button
                      variant="outline"
                      className="w-full flex items-center justify-center gap-2 py-2 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md transition-all duration-200 hover:bg-gray-50 hover:shadow-sm hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] active:shadow-inner"
                      onClick={handleGoogleSignIn}
                      disabled={isLoading.google}>
                      <FcGoogle className="w-5 h-5" />
                      {isLoading.google ? "Signing in..." : "Continue with Google"}
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full flex items-center justify-center gap-2 py-2 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md transition-all duration-200 hover:bg-gray-50 hover:shadow-sm hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] active:shadow-inner"
                      onClick={handleAppleSignIn}
                      disabled={isLoading.apple}>
                      <FaApple className="w-5 h-5" />
                      {isLoading.apple ? "Signing in..." : "Continue with Apple"}
                    </Button>
                  </div>

                  {/* Email Sign In Divider */}
                  <div className="w-full flex flex-col items-center space-y-4 mt-4">
                    <div className="relative flex items-center w-full">
                      <div className="flex-1 border-t border-gray-300"></div>
                      <span className="px-4 text-sm text-gray-500">or</span>
                      <div className="flex-1 border-t border-gray-300"></div>
                    </div>
                  </div>
                </>
              )}

              {/* Email Sign In Button - Enhanced for China region */}
              <div className={`w-full flex flex-col items-center ${IS_CHINA ? "mt-12" : ""}`}>
                <div className={`w-full ${IS_CHINA ? "max-w-xs mx-auto" : ""} space-y-4`}>
                  <Button
                    className="w-full py-3 transition-all duration-200 hover:shadow-sm disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] active:shadow-inner border-2 border-gray-300 hover:border-gray-400 bg-white text-gray-800 hover:bg-gray-50"
                    onClick={handleEmailSignIn}
                    variant="outline"
                    disabled={isLoading.email}>
                    {isLoading.email ? (
                      <span className="flex items-center justify-center">
                        <svg
                          className="animate-spin -ml-1 mr-2 h-4 w-4 text-current"
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24">
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"></circle>
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Processing...
                      </span>
                    ) : (
                      <span className="flex items-center justify-center text-gray-700">
                        <svg
                          className="w-5 h-5 mr-2 text-gray-600"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          xmlns="http://www.w3.org/2000/svg">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
                        </svg>
                        {IS_CHINA ? "Continue with Email" : "Sign in with Email"}
                      </span>
                    )}
                  </Button>
                </div>
              </div>
            </div>

            <div className="text-center text-sm text-gray-500 mt-6">
              <p>By signing in, you agree to our Terms of Service and Privacy Policy.</p>
            </div>

            <div className="text-center text-sm text-gray-500 mt-6">
              <p
                onClick={() => {
                  setIsSignUp(true)
                  setIsEmailModalOpen(true)
                }}
                className="cursor-pointer underline">
                Do not have an account? Sign up
              </p>
            </div>

            {!isSignUp && (
              <div className="text-right text-sm text-gray-500 mt-4">
                <button type="button" onClick={handleForgotPassword} className="cursor-pointer underline">
                  Forgot Password?
                </button>
              </div>
            )}
          </div>
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
