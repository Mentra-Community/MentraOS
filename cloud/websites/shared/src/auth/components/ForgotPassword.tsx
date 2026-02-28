import {useState} from "react"
import {mentraAuthProvider} from "../utils/auth/authProvider"

const ForgotPasswordForm = ({
  redirectTo = "https://console.mentra.glass/reset-password",
  logoUrl = "https://imagedelivery.net/nrc8B2Lk8UIoyW7fY8uHVg/757b23a3-9ec0-457d-2634-29e28f03fe00/verysmall",
}) => {
  const [email, setEmail] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [successMessage, setSuccessMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")

  const isEmailValid = email.includes("@") && email.includes(".")

  const handleSubmit = async () => {
    if (!isEmailValid) {
      setErrorMessage("Please enter a valid email address")
      return
    }

    setIsLoading(true)
    setErrorMessage("")
    setSuccessMessage("")

    try {
      const {error} = await mentraAuthProvider.resetPasswordForEmail(email, redirectTo)
      if (error) {
        setErrorMessage("Failed to send reset email. Please try again.")
      } else {
        setSuccessMessage("Check your email for the password reset link")
      }
    } catch (error) {
      console.error(error)
      setErrorMessage("Failed to send reset email. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && isEmailValid && !isLoading) {
      handleSubmit()
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col" style={{width: "100%"}}>
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-8" style={{maxWidth: "100%"}}>
        <div className="w-full max-w-md mx-auto flex flex-col items-center" style={{maxWidth: "28rem"}}>
          {/* Logo */}
          <img src={logoUrl} alt="Logo" />

          {/* Header */}
          <div className="w-full text-center mt-6 mb-6">
            <h1 className="text-2xl font-bold mb-2">Reset your password</h1>
            <p className="text-sm text-gray-500 mt-1">
              Enter your email address and we will send you a link to reset your password
            </p>
          </div>

          {/* Card */}
          <div className="w-full bg-white p-8 rounded-lg shadow-md">
            <div className="w-full space-y-4">
              {/* Email Input */}
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
                  Email address
                </label>
                <input
                  type="email"
                  id="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="your.email@example.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  disabled={isLoading}
                  autoFocus
                />
              </div>

              {/* Submit Button */}
              <button
                onClick={handleSubmit}
                disabled={isLoading}
                className="w-full py-2 bg-emerald-400 hover:bg-emerald-500 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium rounded text-sm transition-colors duration-200"
                style={{borderRadius: "4px", fontSize: "14px", fontWeight: "500"}}>
                {isLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                        fill="none"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    Sending...
                  </span>
                ) : (
                  "Send reset password instructions"
                )}
              </button>

              {/* Success Message */}
              {successMessage && (
                <div className="p-3 bg-green-50 border border-green-200 rounded-md">
                  <p className="text-sm text-green-700 text-center">{successMessage}</p>
                </div>
              )}

              {/* Error Message */}
              {errorMessage && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                  <p className="text-sm text-red-700 text-center">{errorMessage}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

export default ForgotPasswordForm
