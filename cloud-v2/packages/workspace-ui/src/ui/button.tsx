import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/utils";

/**
 * Mentra's buttons, as on the sign-in page: pills in Red Hat Display SemiBold.
 *
 * - `default`: the primary action, black.
 * - `secondary` (and `outline`, the same button): every other action, grey with a border.
 * - `destructive-secondary`: an action that removes or ends something (Remove, Revoke, Leave), red on grey.
 * - `destructive`: the confirmation of one (Confirm remove, Delete workspace), solid red.
 * - `ghost`: icon buttons and quiet actions in menus. `link`: inline text.
 *
 * Sizes: `lg` (48px, the sign-in page's) for a page's main action, `default` (44px) in forms and
 * headers, `sm` (36px) in rows and lists, and round `icon` buttons.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full border border-transparent font-semibold leading-none transition-[background-color,border-color,opacity] [-webkit-tap-highlight-color:transparent] disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground enabled:hover:opacity-80 [a&]:hover:opacity-80",
        secondary: "border-border bg-surface text-foreground enabled:hover:bg-hover [a&]:hover:bg-hover",
        outline: "border-border bg-surface text-foreground enabled:hover:bg-hover [a&]:hover:bg-hover",
        destructive: "bg-destructive text-white enabled:hover:opacity-85",
        "destructive-secondary": "border-border bg-surface text-destructive enabled:hover:bg-hover",
        ghost: "text-foreground enabled:hover:bg-hover [a&]:hover:bg-hover",
        link: "rounded-none text-foreground underline-offset-[3px] enabled:hover:underline [a&]:hover:underline",
      },
      size: {
        default: "h-11 px-5 text-[15px]",
        sm: "h-9 gap-1.5 px-4 text-sm",
        lg: "h-12 px-6 text-base",
        icon: "size-11",
        "icon-sm": "size-9",
        "icon-lg": "size-12",
      },
    },
    // A link sits in running text: no pill height or padding.
    compoundVariants: [{ variant: "link", className: "h-auto px-0" }],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
