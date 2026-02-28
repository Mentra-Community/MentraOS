import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "./ui/button";
import { useAuth } from "@mentra/shared";

interface DashboardLayoutProps {
  children: React.ReactNode;
}

const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const currentPath = location.pathname;

  // Handle sign out with navigation
  const handleSignOut = async () => {
    await signOut();
    navigate("/login");
  };

  // Helper to check if a path is active (for styling)
  const isActivePath = (path: string): boolean => {
    return currentPath.startsWith(path);
  };

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
            <h2 className="text-xs text-gray-600 pb-1">Account</h2>
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
        <aside className="w-64 bg-white border-r border-gray-200 fixed left-0 top-16 bottom-0 z-10 overflow-y-auto hidden md:block">
          <nav className="p-4 space-y-1">
            <Link
              to="/account"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/account") &&
                !isActivePath("/account/delete") &&
                !isActivePath("/account/export")
                  ? "bg-gray-200 text-gray-900"
                  : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
              }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mr-3 h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
              Profile
            </Link>
            <Link
              to="/account/export"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/account/export")
                  ? "bg-gray-200 text-gray-900"
                  : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
              }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mr-3 h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              Export Data
            </Link>
            <Link
              to="/account/delete"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/account/delete")
                  ? "bg-gray-200 text-gray-900"
                  : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
              }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mr-3 h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
              Delete Account
            </Link>
          </nav>
        </aside>

        {/* Main Content with Margin for Sidebar */}
        <main className="flex-1 md:ml-64 p-6 bg-gray-50 min-h-screen overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
};

export default DashboardLayout;
