"use client";

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/libs/utils";

interface SliderProps extends Omit<React.ComponentProps<typeof SliderPrimitive.Root>, "value" | "defaultValue"> {
  value?: number[];
  defaultValue?: number[];
  showValue?: boolean;
  suffix?: string;
}

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  showValue = false,
  suffix = "",
  ...props
}: SliderProps) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min]),
    [value, defaultValue, min],
  );

  const currentValue = _values[0] ?? min;
  const range = max - min;
  const rawPercentage = range === 0 ? 0 : ((currentValue - min) / range) * 100;
  const fillPercentage = Math.max(0, Math.min(100, rawPercentage));

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 h-[60px]",
        className,
      )}
      {...props}>
      {/* Inactive track - thin line across full width */}
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn("bg-muted relative w-full overflow-hidden rounded-full h-1")}>
        {/* Active range - this is the filled portion shown as thin line */}
        <SliderPrimitive.Range data-slot="slider-range" className={cn("absolute h-full opacity-0")} />
      </SliderPrimitive.Track>

      {/* Custom active track overlay - thick pill that shows the value */}
      <div
        className="absolute left-0 top-1/2 -translate-y-1/2 h-10 bg-primary rounded-full flex items-center justify-between px-3.5 overflow-hidden pointer-events-none"
        style={{
          width: `${Math.max(fillPercentage, 12)}%`,
          minWidth: "40px",
        }}>
        {showValue && (
          <span className="text-primary-foreground text-sm font-semibold whitespace-nowrap">
            {currentValue}
            {suffix}
          </span>
        )}
      </div>

      {/* Invisible thumb for interaction - positioned at the end of the active track */}
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          className="block size-10 shrink-0 rounded-full opacity-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-grab active:cursor-grabbing"
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
