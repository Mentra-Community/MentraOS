import React from "react";
import { cn } from "@/libs/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mentra/shared";
import { ExternalLinkIcon } from "./icons";

interface FormSectionProps {
  /** Section title */
  title: string;
  /** Optional section description */
  description?: string;
  /** Optional icon component to display next to title */
  icon?: React.ReactNode;
  /** Child form elements */
  children: React.ReactNode;
  /** Optional className for custom styling */
  className?: string;
  /** Optional help link to documentation */
  helpLink?: {
    text: string;
    href: string;
  };
}

/**
 * FormSection component for grouping related form fields
 * with a card-based layout for better visual separation.
 */
export function FormSection({
  title,
  description,
  icon,
  children,
  className,
  helpLink,
}: FormSectionProps) {
  return (
    <Card className={cn("shadow-sm border-border/60", className)}>
      <CardHeader className="pb-4 pt-6 px-6">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="text-lg font-semibold flex items-center gap-2.5">
            {icon}
            {title}
          </CardTitle>
          {helpLink && (
            <a
              href={helpLink.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-link hover:text-link-hover hover:underline flex items-center gap-1 shrink-0"
            >
              {helpLink.text}
              <ExternalLinkIcon />
            </a>
          )}
        </div>
        {description && (
          <CardDescription className="mt-1.5 leading-relaxed">{description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-6 px-6 pb-6">{children}</CardContent>
    </Card>
  );
}

export default FormSection;
