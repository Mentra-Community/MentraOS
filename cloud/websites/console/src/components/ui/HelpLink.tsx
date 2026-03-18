import React from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/libs/utils";

const DOCS_BASE_URL = "https://docs.mentraglass.com";

interface HelpLinkProps {
  /** Path to the documentation page (without base URL) */
  path: string;
  /** Link text to display */
  children: React.ReactNode;
  /** Optional className for custom styling */
  className?: string;
  /** Whether to show the external link icon */
  showIcon?: boolean;
}

/**
 * HelpLink component for linking to documentation pages.
 * Automatically prepends the docs base URL and opens in a new tab.
 */
export function HelpLink({
  path,
  children,
  className,
  showIcon = true,
}: HelpLinkProps) {
  // Ensure path starts with /
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const fullUrl = `${DOCS_BASE_URL}${normalizedPath}`;

  return (
    <a
      href={fullUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1 text-sm text-link hover:text-link-hover hover:underline",
        className
      )}
    >
      {children}
      {showIcon && <ExternalLink className="h-3 w-3" />}
    </a>
  );
}

export default HelpLink;
