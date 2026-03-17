import {useState} from "react"
import {mentraAuthProvider} from "../utils/auth/authProvider"
import {mapAuthError} from "../utils/authErrors"
import {Button} from "./ui/button"
import {Input} from "./ui/input"
import {Label} from "./ui/label"
import {Spinner} from "./ui/spinner"
import {IMAGES} from "../../constants/images"

interface ForgotPasswordFormProps {
  redirectTo?: string
  logoUrl?: string
}

const ForgotPasswordForm: React.FC<ForgotPasswordFormProps> = ({
  redirectTo = "https://console.mentra.glass/reset-password",
  logoUrl = IMAGES.iconOnly,
}) => {
  const [email, setEmail] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [successMessage, setSuccessMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")

  const isEmailValid = email.includes("@") && email.includes(".")

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()

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
        setErrorMessage(mapAuthError(error))
      } else {
        setSuccessMessage("Check your email for the password reset link")
      }
    } catch (error) {
      console.error(error)
      setErrorMessage(mapAuthError(error))
    } finally {
      setIsLoading(false)
    }
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

          {/* Header */}
          <p className="text-xl text-secondary-foreground text-center mb-4">
            Reset your password
          </p>
          <p className="text-sm text-muted-foreground text-center mb-6">
            Enter your email address and we'll send you a link to reset your password
          </p>

          {/* Form */}
          <form onSubmit={handleSubmit} className="w-full space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email address</Label>
              <Input
                type="email"
                id="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your.email@example.com"
                disabled={isLoading}
                autoFocus
              />
            </div>

            <Button
              type="submit"
              disabled={isLoading}
              className="w-full">
              {isLoading ? (
                <>
                  <Spinner size="sm" />
                  Sending...
                </>
              ) : (
                "Send Reset Link"
              )}
            </Button>

            {/* Success Message */}
            {successMessage && (
              <div className="text-sm text-accent text-center mt-2">
                {successMessage}
              </div>
            )}

            {/* Error Message */}
            {errorMessage && (
              <div className="text-sm text-destructive text-center mt-2">
                {errorMessage}
              </div>
            )}
          </form>

          {/* Back to sign in link */}
          <div className="flex items-center justify-center gap-1 mt-6">
            <a
              href="/login"
              className="text-sm text-accent font-semibold cursor-pointer hover:underline">
              Back to sign in
            </a>
          </div>
        </div>
      </main>
    </div>
  )
}

export default ForgotPasswordForm
