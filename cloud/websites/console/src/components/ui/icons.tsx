import { cn } from "@/libs/utils";

interface IconProps {
  className?: string;
}

/**
 * External link icon - use this instead of inline SVG definitions
 * Matches the style used throughout the app for "Learn more" links
 */
export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={cn("h-3 w-3", className)}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
      />
    </svg>
  );
}
