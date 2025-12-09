import {User} from "lucide-react"
import {useAuth} from "@mentra/shared"
import {useTheme} from "../hooks/useTheme"
import {useNavigate} from "react-router-dom"
import {useProfileDropdown} from "../contexts/ProfileDropdownContext"

interface ProfileDropdownProps {
  variant?: "mobile" | "desktop"
  className?: string
}

export const ProfileDropdown: React.FC<ProfileDropdownProps> = ({variant = "desktop", className = ""}) => {
  const {signOut, user} = useAuth()
  const {theme} = useTheme()
  const navigate = useNavigate()
  const profileDropdown = useProfileDropdown()

  const getUserAvatar = () => {
    if (!user) return null
    return (user as any).avatarUrl || null
  }

  const handleSignOut = async () => {
    try {
      await signOut()
      profileDropdown.setIsOpen(false)
      navigate("/")
    } catch (error) {
      console.error("Error signing out:", error)
    }
  }

  if (variant === "mobile") {
    return (
      <div className={`flex flex-col rounded-xl shadow-2xl overflow-hidden ${className}`}>
        {/* User Info Section */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{
            borderColor: "var(--border-color)",
            backgroundColor: theme === "light" ? "#fafafa" : "var(--bg-secondary)",
          }}>
          <div
            className="w-11 h-11 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0"
            style={{
              backgroundColor: theme === "light" ? "#F2F2F2" : "var(--bg-tertiary)",
            }}>
            {getUserAvatar() ? (
              <img
                key={getUserAvatar()}
                src={getUserAvatar()!}
                alt="Profile"
                className="w-full h-full object-cover"
                onError={(e) => {
                  console.error("Failed to load avatar:", getUserAvatar())
                  e.currentTarget.style.display = "none"
                }}
              />
            ) : (
              <User
                size={22}
                style={{
                  color: "var(--text-muted)",
                }}
              />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p
              className="font-medium text-sm truncate"
              style={{
                color: "var(--text-primary)",
              }}>
              {user?.name || user?.email?.split("@")[0] || "User"}
            </p>
            <p
              className="text-xs mt-0.5 truncate"
              style={{
                color: "var(--text-secondary)",
              }}>
              {user?.email || "No email"}
            </p>
          </div>
        </div>

        {/* Sign Out Button */}
        <button
          onClick={handleSignOut}
          className="w-full text-left px-4 py-2.5 text-sm text-red-600 font-medium transition-colors"
          style={{
            backgroundColor: "var(--bg-primary)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = theme === "light" ? "#f3f4f6" : "#27272a")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-primary)")}>
          Sign Out
        </button>
      </div>
    )
  }

  // Desktop variant
  return (
    <div
      className={`flex flex-col rounded-xl overflow-hidden ${className}`}
      style={{
        backgroundColor: "var(--bg-primary)",
      }}>
      {/* User Info Section */}
      <div
        className="flex items-center gap-3 px-4 py-3 border-b"
        style={{
          borderColor: "var(--border-color)",
          backgroundColor: theme === "light" ? "#fafafa" : "var(--bg-secondary)",
        }}>
        <div
          className="w-11 h-11 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0"
          style={{
            backgroundColor: theme === "light" ? "#F2F2F2" : "var(--bg-tertiary)",
          }}>
          {getUserAvatar() ? (
            <img
              key={getUserAvatar()}
              src={getUserAvatar()!}
              alt="Profile"
              className="w-full h-full object-cover"
              onError={(e) => {
                console.error("Failed to load avatar in dropdown:", getUserAvatar())
                e.currentTarget.style.display = "none"
              }}
            />
          ) : (
            <User
              size={22}
              style={{
                color: "var(--text-muted)",
              }}
            />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p
            className="font-medium text-sm truncate"
            style={{
              color: "var(--text-primary)",
            }}>
            {user?.name || user?.email?.split("@")[0] || "User"}
          </p>
          <p
            className="text-xs mt-0.5 truncate"
            style={{
              color: "var(--text-secondary)",
            }}>
            {user?.email || "No email"}
          </p>
        </div>
      </div>

      {/* Sign Out Button */}
      <button
        onClick={handleSignOut}
        className="w-full text-left px-4 py-2.5 text-sm text-red-600 font-medium transition-colors"
        style={{
          backgroundColor: "transparent",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = theme === "light" ? "#f3f4f6" : "#27272a")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}>
        Sign Out
      </button>
    </div>
  )
}
