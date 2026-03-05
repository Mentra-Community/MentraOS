"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/libs/utils";
import { Button } from "@mentra/shared";

interface DatePickerProps {
  className?: string;
  initialMonth?: number;
  initialYear?: number;
  onMonthYearChange?: (month: number, year: number) => void;
  setMonthNumberDynamic?: (monthName: number) => void;
  setYearNumber?: (yearNumber: number) => void;
  // Styling props
  containerClassName?: string;
  textClassName?: string;
  buttonClassName?: string;
  buttonHoverClassName?: string;
  width?: string;
  backgroundColor?: string;
  borderRadius?: string;
  onNextMonth?: () => void;
  onPrevMonth?: () => void;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const START_UPTIME_MONTH = 7; // January
const START_UPTIME_YEAR = 2025;

export function DatePicker({
  className,
  initialMonth,
  initialYear,
  onMonthYearChange,
  setMonthNumberDynamic,
  setYearNumber,
  containerClassName,
  textClassName,
  buttonClassName,
  buttonHoverClassName,
  width = "w-full",
  backgroundColor = "bg-white",
  borderRadius = "rounded-[10px]",
  onNextMonth,
  onPrevMonth,
}: DatePickerProps) {
  const currentDate = new Date();
  const [month, setMonth] = React.useState(
    initialMonth ?? currentDate.getMonth(),
  );
  const [year, setYear] = React.useState(
    initialYear ?? currentDate.getFullYear(),
  );

  React.useEffect(() => {
    if (initialMonth !== undefined) {
      setMonth(initialMonth);
      setMonthNumberDynamic?.(initialMonth);
    }

    if (initialYear !== undefined) {
      setYear(initialYear);
      setYearNumber?.(initialYear);
    }
  }, [initialMonth, initialYear, setMonthNumberDynamic, setYearNumber]);

  return (
    <div className={cn(`flex ${backgroundColor} ${borderRadius}`, className)}>
      <div
        className={cn(
          `flex justify-center items-center relative ${width}`,
          containerClassName,
        )}
      >
        <Button
          variant="outline"
          size="icon"
          className={cn(
            "absolute left-1 w-7 h-7 bg-transparent p-0 opacity-50 transition-opacity duration-200 ease-out border-0 hover:opacity-100",
            buttonClassName,
            buttonHoverClassName,
          )}
          onClick={onPrevMonth}
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>

        <div className={cn("text-sm font-medium", textClassName)}>
          {MONTHS[month]} {year}
        </div>

        <Button
          variant="outline"
          size="icon"
          className={cn(
            "absolute right-1 w-7 h-7 bg-transparent p-0 opacity-50 transition-opacity duration-200 ease-out border-0 hover:opacity-100",
            buttonClassName,
            buttonHoverClassName,
          )}
          onClick={onNextMonth}
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
