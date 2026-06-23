interface SettingItemProps {
  isFirstItem: boolean;
  isLastItem: boolean;
  settingItemName?: string;
  className?: string;
  description?: string;
  onClick?: () => void;
  customContent?: React.ReactNode;
}

function SettingItem({
  isFirstItem,
  isLastItem,
  className,
  settingItemName,
  description,
  onClick,
  customContent
}: SettingItemProps) {
  const baseClasses = 'p-[10px] flex items-center justify-between px-[16px] h-[56px]';
  const roundedClasses = isFirstItem
    ? 'rounded-tr-[16px] rounded-tl-[16px] rounded-bl-[5px] rounded-br-[5px]'
    : isLastItem
    ? 'rounded-br-[16px] rounded-bl-[16px] rounded-tl-[5px] rounded-tr-[5px]'
    : 'rounded-[5px]';

  return (
    <div
      className={`${baseClasses} ${roundedClasses} ${className || ''}`}
      style={{ backgroundColor: 'var(--primary-foreground)' }}
      onClick={onClick}
    >
      <span
        className="text-[14px] font-medium font-semibold"
        style={{ color: 'var(--secondary-foreground)' }}
      >
        {settingItemName}
      </span>
      {customContent || (
        <span
          className="text-[14px] font-normal"
          style={{ color: 'var(--secondary-foreground)' }}
        >
          {description}
        </span>
      )}
    </div>
  );
}

export default SettingItem;
