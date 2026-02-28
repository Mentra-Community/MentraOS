import React from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@mentra/shared";
import { usePlatform } from "../hooks/usePlatform";
import { useTheme } from "../hooks/useTheme";
import { useIsDesktop, useIsMobile } from "../hooks/useMediaQuery";
import { useSearch } from "../contexts/SearchContext";
import { Button } from "./ui/button";
import GetMentraOSButton from "./GetMentraOSButton";
import SearchBar from "./SearchBar";

interface HeaderProps {
  onSearch?: (e: React.FormEvent) => void;
  onSearchClear?: () => void;
}

const Header: React.FC<HeaderProps> = ({ onSearch, onSearchClear }) => {
  const { isAuthenticated, signOut } = useAuth();
  const { isWebView } = usePlatform();
  const { theme } = useTheme();
  const { searchQuery, setSearchQuery } = useSearch();
  const navigate = useNavigate();
  const location = useLocation();
  const isDesktop = useIsDesktop();
  const isMobile = useIsMobile();
  const isStorePage = location.pathname === "/";

  // Handle sign out
  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  // Don't show header in webview
  if (isWebView) {
    return null;
  }

  return (
    <header
      className="sticky top-0 z-10"
      style={{
        background: theme === "light" ? "#ffffff" : "linear-gradient(to bottom, #0c0d27, #030514)",
        borderBottom: `1px solid var(--border-color)`,
      }}>
      <div className="container mx-auto px-4 py-4">
        {/* Two-row layout for medium screens, single row for large+ */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          {/* Top row: Logo and Buttons */}
          <div className="flex items-center justify-between">
            {/* Logo and Site Name */}
            <Link to="/" className="flex items-center gap-3 select-none hover:opacity-80 transition-opacity">
              <img
                src={theme === "light" ? "/icon_black.svg" : "/icon_white.svg"}
                alt="Mentra Logo"
                className="h-8 w-8"
              />
              <span
                className="text-[26px] font-semibold"
                style={{
                  fontFamily: '"Red Hat Display", sans-serif',
                  letterSpacing: "0.06em",
                  color: "var(--text-primary)",
                }}>
                Mentra MiniApp Store
              </span>
            </Link>

            {/* Buttons container - only visible on mobile/tablet in top row */}
            <div className="flex items-center gap-3 lg:hidden">
              {/* Get MentraOS Button - Only visible on small screens and up */}
              {/* <div className="hidden sm:block">
                <GetMentraOSButton size="small" />
              </div> */}

              {/* Authentication */}
              {isAuthenticated ? (
                <Button
                  onClick={handleSignOut}
                  variant={theme === "light" ? "default" : "outline"}
                  className="rounded-full border-[1.5px]"
                  style={{
                    backgroundColor: theme === "light" ? "#000000" : "transparent",
                    borderColor: theme === "light" ? "#000000" : "#C0C4FF",
                    color: theme === "light" ? "#ffffff" : "#C0C4FF",
                  }}>
                  Sign Out
                </Button>
              ) : (
                <Button
                  onClick={() => navigate("/login")}
                  variant={theme === "light" ? "default" : "outline"}
                  className="rounded-full border-[1.5px]"
                  style={{
                    backgroundColor: theme === "light" ? "#000000" : "transparent",
                    borderColor: theme === "light" ? "#000000" : "#C0C4FF",
                    color: theme === "light" ? "#ffffff" : "#C0C4FF",
                  }}>
                  Sign In
                </Button>
              )}
            </div>
          </div>

          {/* Search bar - second row on medium, center on large+ */}
          {!isMobile && isStorePage && onSearch && (
            <div
              className="w-full lg:flex-1 lg:max-w-md lg:mx-auto pt-4 lg:pt-0"
              style={{
                borderTop: !isDesktop ? `1px solid var(--border-color)` : "none",
                marginTop: !isDesktop ? "1rem" : "0",
              }}>
              <SearchBar
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onSearchSubmit={onSearch}
                onClear={onSearchClear || (() => setSearchQuery(""))}
              />
            </div>
          )}

          {/* Buttons for large screens - in the same row */}
          <div className="hidden lg:flex items-center gap-4">
            {/* Get MentraOS Button */}
            <GetMentraOSButton size="small" />

            {/* Authentication */}
            {isAuthenticated ? (
              <Button
                onClick={handleSignOut}
                variant={theme === "light" ? "default" : "outline"}
                className="rounded-full border-[1.5px]"
                style={{
                  backgroundColor: theme === "light" ? "#000000" : "transparent",
                  borderColor: theme === "light" ? "#000000" : "#C0C4FF",
                  color: theme === "light" ? "#ffffff" : "#C0C4FF",
                }}>
                Sign Out
              </Button>
            ) : (
              <Button
                onClick={() => navigate("/login")}
                variant={theme === "light" ? "default" : "outline"}
                className="rounded-full border-[1.5px]"
                style={{
                  backgroundColor: theme === "light" ? "#000000" : "transparent",
                  borderColor: theme === "light" ? "#000000" : "#C0C4FF",
                  color: theme === "light" ? "#ffffff" : "#C0C4FF",
                }}>
                Sign In
              </Button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
