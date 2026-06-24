import React from 'react';
import { Settings, ArrowLeft } from 'lucide-react';

interface HeaderProps {
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  onSettingsClick: () => void;
  showBackArrow?: boolean;
}

/**
 * Header component with Menu button (left) and Settings button (right)
 */
function Header({
  onSettingsClick,
  showBackArrow = false
}: HeaderProps) {
  return (
    <div className="w-full flex items-center justify-between px-[24px] relative z-10 mt-1">
      {/* Left side - Back arrow (settings page), Settings button, or Menu button */}
      {showBackArrow ? (
        <button
          onClick={onSettingsClick}
          className=" rounded-full flex items-center justify-center transition-all duration-300 hover:opacity-80 hover:scale-110"
          style={{ backgroundColor: 'var(--primary-foreground)' }}
        >
          <ArrowLeft className="w-6 h-6" style={{ color: 'var(--secondary-foreground)' }} />
        </button>
      ) : (
        <button
          onClick={onSettingsClick}
          className="  h-[40px] rounded-full flex items-center justify-center transition-all duration-300 hover:opacity-80 hover:scale-110"
          style={{ backgroundColor: 'transparent' }}
        >
          <Settings className="w-6 h-6" style={{ color: 'var(--secondary-foreground)' }} />
        </button>
      )}

      {/* Right side - spacer */}
      <div className="w-[40px] h-[40px]" />
    </div>
  );
}

export default Header;
