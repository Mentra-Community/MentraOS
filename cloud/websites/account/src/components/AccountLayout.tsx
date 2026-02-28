import React from "react";
import { Link, useLocation, Navigate } from "react-router-dom";
import { useAuth } from "@mentra/shared";

interface AccountLayoutProps {
  children: React.ReactNode;
}

const AccountLayout: React.FC<AccountLayoutProps> = ({ children }) => {
  const location = useLocation();
  const { isAuthenticated, isLoading, signOut } = useAuth();

  // If still loading, show loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  // If not authenticated, redirect to login
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div className="flex items-center">
            <Link to="/" className="text-xl font-bold text-gray-900">
              Mentra Account
            </Link>
          </div>

          <div>
            <button
              onClick={() => signOut()}
              className="ml-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-red-700 bg-red-50 hover:bg-red-100"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main>
        <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row gap-6">
            {/* Sidebar */}
            <div className="w-full md:w-64 shrink-0">
              <div className="bg-white shadow rounded-lg overflow-hidden">
                <div className="px-4 py-5 sm:p-6">
                  <nav className="space-y-1">
                    <NavLink to="/account/profile">Profile</NavLink>
                    <NavLink to="/account/data">Data Export</NavLink>
                    <NavLink to="/account/delete">Delete Account</NavLink>
                  </nav>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 bg-white shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">{children}</div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

// NavLink component with active state handling
const NavLink = ({
  to,
  children,
}: {
  to: string;
  children: React.ReactNode;
}) => {
  const location = useLocation();
  const isActive = location.pathname === to;

  return (
    <Link
      to={to}
      className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
        isActive
          ? "bg-blue-50 text-blue-700"
          : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
      }`}
    >
      {children}
    </Link>
  );
};

export default AccountLayout;
