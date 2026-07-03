import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type BadgeTone = "success" | "warn" | "neutral";

type BadgeProps = ComponentProps<"div"> & {
  icon?: LucideIcon;
  tone?: BadgeTone;
};

const toneClasses: Record<BadgeTone, string> = {
  success: "border-[#bfe9db] bg-[#ecfbf5] text-[#176b58]",
  warn: "border-[#f4d7a2] bg-[#fff8e8] text-[#8b5c12]",
  neutral: "border-[#dfe7e1] bg-white text-[#566962]",
};

export function Badge({ children, icon: Icon, tone = "neutral", className, ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-semibold",
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      {Icon ? <Icon className="size-3.5" /> : null}
      {children}
    </div>
  );
}
