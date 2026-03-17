import React from "react";
import { Badge } from "@mentra/shared";
import {
  updateDayBar,
  UptimeStreakBar,
  type AppBatchItem,
} from "./upTimeStreakBar";

// Re-export for convenience
export { updateDayBar, UptimeStreakBar, type AppBatchItem };

// --- TYPE DEFINITIONS ---
// It's good practice to define types for component props.

// Props for the CheckIcon component
interface CheckIconProps {
  className?: string;
}

// Props for the StatusBar component
interface StatusBarProps {
  color: string;
}

// Props for the UptimeStatus component
interface UptimeStatusProps {
  title: string;
  uptimePercentage: number;
  barCount?: number;
  month: number;
  year: number;
  appHealthStatus: string;
  appItems: AppBatchItem[];
}

// Props for the StatusBadge component
interface StatusBadgeProps {
  status: "pending" | "offline" | "online" | string;
  className?: string;
}

const monthDays = {
  january: 31,
  february: 28,
  februaryLeap: 29,
  march: 31,
  april: 30,
  may: 31,
  june: 30,
  july: 31,
  august: 31,
  september: 30,
  october: 31,
  november: 30,
  december: 31,
  test: 1,
};

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

// --- SVG ICON COMPONENT ---
// A dedicated component for the checkmark icon makes it reusable.
const CheckIcon: React.FC<CheckIconProps> = ({
  className = "w-6 h-6 text-green-500",
}) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);

// --- STATUS BADGE COMPONENT ---
// A reusable status badge component with colored indicators
export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  className,
}) => {
  const getStatusColor = () => {
    switch (status.toLocaleLowerCase()) {
      case "online":
        return "bg-green-500";
      default:
        return "bg-red-600";
    }
  };

  const getStatusText = () => {
    switch (status.toLocaleLowerCase()) {
      case "online":
        return "Online";
      default:
        return "Offline";
    }
  };

  return (
    <div>
      <Badge variant="outline" className={`text-xs ${className} w-17`}>
        <div className={`w-2 h-2 rounded-full ${getStatusColor()}`}></div>
        <span>{getStatusText()}</span>
      </Badge>
    </div>
  );
};

// --- STATUS BAR COMPONENT ---
// A simple component to render a single status bar.
// This makes the main component's render method cleaner.
const StatusBar: React.FC<StatusBarProps> = ({ color }) => (
  <div className={`flex-none w-1.5 h-5 ${color} rounded-[2px]`} />
);

// --- MAIN UPTIME STATUS COMPONENT ---
// This component combines the header and the status bars.
export const UptimeStatus: React.FC<UptimeStatusProps> = ({
  title,
  uptimePercentage,
  month,
  appHealthStatus,
  appItems,
}) => {
  const normalizedMonth = MONTH_NAMES[month].toLowerCase();

  const isLeapYear = false; // Or add a parameter/logic for leap year
  const daysInMonth =
    normalizedMonth === "february" && isLeapYear
      ? monthDays.februaryLeap
      : monthDays[normalizedMonth as keyof typeof monthDays] || 30;

  const finalBarCount = daysInMonth;
  const bars = Array.from({ length: finalBarCount });

  console.log("App items:", appItems);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-row items-center w-60">
        <div className="text-xs flex-1">Uptime: {uptimePercentage}%</div>
        <StatusBadge status={appHealthStatus} />
      </div>
      <div className="flex items-center gap-0.5 overflow-x-auto">
        {bars.map((_, day) => (
          <>{updateDayBar(day + 1, appItems)}</>
        ))}
      </div>
    </div>
  );
};
