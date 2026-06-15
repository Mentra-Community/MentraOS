import { Moon, Sun } from 'lucide-react';

interface ToggleSwitchProps {
  isOn: boolean;
  onToggle: () => void;
  label?: string;
}

function ToggleSwitch({ isOn, onToggle, label }: ToggleSwitchProps) {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle();
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center justify-between"
      aria-label={label}
    >
      <div
        className="relative w-[51px] h-[31px] rounded-full transition-all duration-300"
        style={{
          backgroundColor: isOn ? 'var(--secondary-foreground)' : 'rgba(128, 128, 128, 0.3)',
        }}
      >
        {/* Toggle knob */}
        <div
          className="absolute top-[3px] w-[25px] h-[25px] rounded-full bg-white transition-all duration-300 flex items-center justify-center z-20"
          style={{
            left: isOn ? '23px' : '3px',
            backgroundColor: 'var(--primary-foreground)',
          }}
        >
          {isOn ? (
            <Moon size={12} style={{ color: 'var(--secondary-foreground)' }} />
          ) : (
            <Sun size={12} style={{ color: 'var(--secondary-foreground)' }} />
          )}
        </div>
      </div>
    </button>
  );
}

export default ToggleSwitch;
