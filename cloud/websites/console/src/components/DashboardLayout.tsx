// components/DashboardLayout.tsx
import { useState, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button, IMAGES, useAuth } from "@mentra/shared";
import api from "@/services/api.service";
import OrgSwitcher from "./OrgSwitcher";
import ContactEmailBanner from "./ui/ContactEmailBanner";
import { useAccountStore } from "@/stores/account.store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Home, Package, Building2, Users, Terminal, ClipboardCheck, FileText, Cpu, User, AlertTriangle } from "lucide-react";

interface DashboardLayoutProps {
  children: React.ReactNode;
}

const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const currentPath = location.pathname;
  const [isAdmin, setIsAdmin] = useState(false);
  const email = useAccountStore((s) => s.email);

  // Check if the user is an admin
  useEffect(() => {
    // Start with admin set to false - don't show admin panel by default
    setIsAdmin(false);

    const checkAdminStatus = async () => {
      try {
        // First, check if we have a token
        const authToken = localStorage.getItem("core_token");
        if (!authToken) {
          return;
        }

        // Try to use API service
        try {
          const result = await api.admin.checkAdmin();
          // Only set admin to true if the API explicitly confirms admin status
          if (result && result.isAdmin === true) {
            setIsAdmin(true);
          }
        } finally {
          console.log("");
        }
      } catch (error) {
        console.error("Error checking admin status:", error);
      }
    };

    checkAdminStatus();
  }, []);

  // Handle sign out with navigation
  const handleSignOut = async () => {
    await signOut();
    navigate("/signin");
  };

  // Helper to check if a path is active (for styling)
  const isActivePath = (path: string): boolean => {
    if (path === "/dashboard") {
      return currentPath === "/dashboard";
    }
    // For /apps, we want to highlight for all routes under /apps
    return currentPath.startsWith(path);
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Fixed Header */}
      <header className="h-16 bg-card border-b border-border fixed top-0 left-0 right-0 z-10">
        <div className="mx-auto px-5 sm:px-6 lg:px-8 h-full flex items-center justify-between">
          <div className="select-none">
            <div className="flex items-end gap-0">
              <img src={IMAGES.logoLight} alt="Mentra Logo" className="h-6" />
            </div>
            <h2 className="text-xs text-muted-foreground pb-1">Developer Portal</h2>
          </div>

          <div className="flex items-center gap-2">
            <Link to="https://docs.mentra.glass">
              <Button variant="ghost" size="sm" className="hover:bg-secondary">
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
        <aside className="w-64 bg-card border-r border-border fixed left-0 top-16 bottom-0 z-10 hidden md:flex md:flex-col">
          <nav className="p-4 space-y-1 flex-1 overflow-y-auto flex flex-col">
            {/* Organization Switcher */}
            <OrgSwitcher />

            <Link
              to="/dashboard"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/dashboard")
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}>
              <Home className="mr-3 h-5 w-5" />
              Dashboard
            </Link>
            <Link
              to="/apps"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/apps")
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}>
              <Package className="mr-3 h-5 w-5" />
              My MiniApps
            </Link>
            <Link
              to="/org-settings"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/org-settings")
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}>
              <Building2 className="mr-3 h-5 w-5" />
              Organization Settings
            </Link>
            <Link
              to="/members"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/members")
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}>
              <Users className="mr-3 h-5 w-5" />
              Members
            </Link>

            <Link
              to="/cli-keys"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/cli-keys")
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}>
              <Terminal className="mr-3 h-5 w-5" />
              CLI Keys
            </Link>

            <Link
              to="/store-guidelines"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/store-guidelines")
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}>
              <ClipboardCheck className="mr-3 h-5 w-5" />
              Store Guidelines
            </Link>

            <Link
              to="https://docs.mentra.glass"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                isActivePath("/docs")
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}>
              <FileText className="mr-3 h-5 w-5" />
              Documentation
            </Link>

            {isAdmin && (
              <>
                <Link
                  to="/admin"
                  className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                    currentPath === "/admin"
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}>
                  <Cpu className="mr-3 h-5 w-5" />
                  Admin Panel
                </Link>
                <Link
                  to="/admin/incidents"
                  className={`flex items-center px-3 py-2 text-sm font-medium rounded-md ${
                    currentPath.startsWith("/admin/incidents")
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}>
                  <AlertTriangle className="mr-3 h-5 w-5" />
                  Incidents
                </Link>
              </>
            )}
          </nav>

          {/* Account footer */}
          <div className="mt-auto p-2 border-t border-border">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="w-full justify-start text-foreground hover:bg-secondary">
                  <User className="mr-3 h-5 w-5 text-muted-foreground" />
                  <span className="truncate">{email ?? "Account"}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-64">
                <DropdownMenuLabel>Signed in</DropdownMenuLabel>
                <div className="px-2 py-1.5 text-sm text-muted-foreground truncate">{email ?? "unknown@user"}</div>
                <DropdownMenuSeparator />

                <DropdownMenuItem onClick={handleSignOut}>Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </aside>

        {/* Main Content with Margin for Sidebar */}
        <main className="flex-1 md:ml-64 p-6 bg-background min-h-screen overflow-y-auto">
          <ContactEmailBanner />
          {children}
        </main>
      </div>
    </div>
  );
};

export default DashboardLayout;
