import React from 'react';
import { Settings as SettingsIcon, ArrowLeft } from 'lucide-react';
// @ts-ignore - SVG import
import ColorMiraLogo from '../../public/figma-parth-assets/icons/color-mira-logo.svg';

interface HeaderProps {
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  /** Left-button action: open settings on the chat header, go back on the settings header. */
  onSettingsClick: () => void;
  showBackArrow?: boolean;
  /** Title text. Defaults to "Mentra AI" (chat) or "Settings" (back variant). */
  title?: string;
}

/**
 * Top bar. Chat variant: [gear] [sparkle] "Mentra AI". Back variant: [‹] "Settings".
 */
function Header({ onSettingsClick, showBackArrow = false, title }: HeaderProps) {
  const heading = title ?? (showBackArrow ? 'Settings' : 'Mentra AI');

  return (
    <div className="relative z-10 mt-2 flex h-[44px] w-full items-center gap-2.5 px-[24px]">
      <button
        onClick={onSettingsClick}
        aria-label={showBackArrow ? 'Back' : 'Settings'}
        className="flex h-9 w-9 items-center justify-center rounded-full transition-all duration-200 hover:opacity-80 active:scale-95"
      >
        {showBackArrow ? (
          <ArrowLeft className="h-6 w-6" style={{ color: 'var(--secondary-foreground)' }} />
        ) : (
          <SettingsIcon className="h-[22px] w-[22px]" style={{ color: 'var(--secondary-foreground)' }} />
        )}
      </button>

      {/* Sparkle logo only on the main (chat) header */}
      {!showBackArrow && <img src={ColorMiraLogo} alt="" className="-ml-0.5 h-7 w-7" />}

      <h1
        className={`font-semibold ${showBackArrow ? 'text-[22px]' : 'text-[18px]'}`}
        style={{ color: 'var(--secondary-foreground)' }}
      >
        {heading}
      </h1>
    </div>
  );
}

export default Header;
