// components/DashboardLayout.tsx
import {useState, useEffect} from "react"
import {Link, useLocation, useNavigate} from "react-router-dom"
import {Button} from "@/components/ui/button"
import {useAuth} from "@mentra/shared"
import api from "@/services/api.service"
import OrgSwitcher from "./OrgSwitcher"
import ContactEmailBanner from "./ui/ContactEmailBanner"
import {useAccountStore} from "@/stores/account.store"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface DashboardLayoutProps {
  children: React.ReactNode
}

const DashboardLayout: React.FC<DashboardLayoutProps> = ({children}) => {
  const location = useLocation()
  const navigate = useNavigate()
  const {signOut} = useAuth()
  const currentPath = location.pathname
  const [isAdmin, setIsAdmin] = useState(false)
  const email = useAccountStore((s) => s.email)

  // Check if the user is an admin
  useEffect(() => {
    // Start with admin set to false - don't show admin panel by default
    setIsAdmin(false)

    const checkAdminStatus = async () => {
      try {
        // First, check if we have a token
        const authToken = localStorage.getItem("core_token")
        if (!authToken) {
          return
        }

        // Try to use API service
        try {
          const result = await api.admin.checkAdmin()
          // Only set admin to true if the API explicitly confirms admin status
          if (result && result.isAdmin === true) {
            setIsAdmin(true)
          }
        } finally {
          console.log("")
        }
      } catch (error) {
        console.error("Error checking admin status:", error)
      }
    }

    checkAdminStatus()
  }, [])

  // Handle sign out with navigation
  const handleSignOut = async () => {
    await signOut()
    navigate("/signin")
  }

  // Helper to check if a path is active (for styling)
  const isActivePath = (path: string): boolean => {
    if (path === "/dashboard") {
      return currentPath === "/dashboard"
    }
    // For /apps, we want to highlight for all routes under /apps
    return currentPath.startsWith(path)
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Fixed Header */}
      <header className="h-16 bg-white border-b border-gray-200 fixed top-0 left-0 right-0 z-10">
        <div className="mx-auto px-5 sm:px-6 lg:px-8 h-full flex items-center justify-between">
          <div className="select-none">
            <div className="flex items-end gap-0">
              <img
                src="https://imagedelivery.net/nrc8B2Lk8UIoyW7fY8uHVg/757b23a3-9ec0-457d-2634-29e28f03fe00/verysmall"
                alt="Mentra Logo"
              />
            </div>
            <h2 className="text-xs text-gray-600 pb-1">Developer Portal</h2>
          </div>

          <div className="flex items-center gap-2">
            <Link to="https://docs.mentra.glass">
              <Button variant="ghost" size="sm" className="hover:bg-gray-200">
                Documentation
              </Button>
            </Link>
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content Area with Fixed Sidebar */}
      <div className="flex pt-16 flex-1">
        {/* Fixed Sidebar */}
        <aside className="w-64 bg-white border-r border-gray-200 fixed left-0 top-16 bottom-0 z-10 hidden md:flex md:flex-col">
          <nav className="p-4 space-y-1 flex-1 overflow-y-auto flex flex-col">
            {/* Organization Switcher */}
            <OrgSwitcher />

            <Link
              to="/dashboard"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/dashboard")
                  ? "bg-gray-200 text-gray-900"
                  : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
              }`}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mr-3 h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                />
              </svg>
              Dashboard
            </Link>
            <Link
              to="/apps"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/apps")
                  ? "bg-gray-200 text-gray-900"
                  : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
              }`}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mr-3 h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
              My Apps
            </Link>
            <Link
              to="/org-settings"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/org-settings")
                  ? "bg-gray-200 text-gray-900"
                  : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
              }`}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mr-3 h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                />
              </svg>
              Organization Settings
            </Link>
            <Link
              to="/members"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/members")
                  ? "bg-gray-200 text-gray-900"
                  : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
              }`}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mr-3 h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
              Members
            </Link>

            <Link
              to="/cli-keys"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/cli-keys")
                  ? "bg-gray-200 text-gray-900"
                  : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
              }`}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mr-3 h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              CLI Keys
            </Link>

            <Link
              to="https://docs.mentra.glass"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/docs")
                  ? "bg-gray-200 text-gray-900"
                  : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
              }`}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mr-3 h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              Documentation
            </Link>

            {isAdmin && (
              <Link
                to="/admin"
                className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                  isActivePath("/admin")
                    ? "bg-gray-200 text-gray-900"
                    : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
                }`}>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="mr-3 h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
                  />
                </svg>
                Admin Panel
              </Link>
            )}
          </nav>

          {/* Account footer */}
          <div className="mt-auto p-2 border-t">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="w-full justify-start text-gray-700 hover:bg-gray-100">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="mr-3 h-5 w-5 text-gray-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                    />
                  </svg>
                  <span className="truncate">{email ?? "Account"}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-64">
                <DropdownMenuLabel>Signed in</DropdownMenuLabel>
                <div className="px-2 py-1.5 text-sm text-muted-foreground truncate">{email ?? "unknown@user"}</div>
                <DropdownMenuSeparator />

                <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={() => signOut()}>
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </aside>

        {/* Main Content with Margin for Sidebar */}
        <main className="flex-1 md:ml-64 p-6 bg-gray-50 min-h-screen overflow-y-auto">
          <ContactEmailBanner />
          {children}
        </main>
      </div>
    </div>
  )
}

export default DashboardLayout
