import { useState, useRef, useEffect } from "react";

interface DropDownProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  closeOnClickOutside?: boolean;
}

export const DropDown: React.FC<DropDownProps> = ({
  trigger,
  children,
  className = "",
  contentClassName = "",
  closeOnClickOutside = true,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const toggleDropdown = () => {
    setIsOpen(!isOpen);
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        closeOnClickOutside &&
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, closeOnClickOutside]);

  return (
    <div ref={dropdownRef} className={`relative ${className}`}>
      <div onClick={toggleDropdown} className="cursor-pointer">
        {trigger}
      </div>

      {isOpen && (
        <div className={`absolute z-50 ${contentClassName}`}>{children}</div>
      )}
    </div>
  );
};
