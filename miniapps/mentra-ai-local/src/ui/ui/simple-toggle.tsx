interface SimpleToggleProps {
  isOn: boolean;
  onToggle: () => void;
  label?: string;
}

function SimpleToggle({ isOn, onToggle, label }: SimpleToggleProps) {
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
        {/* Toggle knob - no icons */}
        <div
          className="absolute top-[3px] w-[25px] h-[25px] rounded-full transition-all duration-300"
          style={{
            left: isOn ? '23px' : '3px',
            backgroundColor: 'var(--primary-foreground)',
          }}
        />
      </div>
    </button>
  );
}

export default SimpleToggle;
