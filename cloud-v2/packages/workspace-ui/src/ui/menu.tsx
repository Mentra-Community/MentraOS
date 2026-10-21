import { useCallback, useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { useDismiss } from "../shell/use-dismiss";
import { Button } from "./button";

/** One row of a {@link Menu}. */
export interface MenuItem {
  key: string;
  /** What the row says; a node, so an item that leaves the portal can carry its ↗. */
  label: ReactNode;
  /** Runs once when the row is chosen (Enter, Space or a click). The menu closes and the button gets focus back first. */
  onSelect(): void;
  disabled?: boolean;
  /** Red, for an item that removes or ends something. */
  destructive?: boolean;
}

const ITEM_SELECTOR = '[role="menuitem"]:not(:disabled)';

/**
 * A button that opens a list of actions: a card's "…", "Change role". It is the menu button pattern:
 *
 * - Enter, Space or a click opens it with focus on the first item; ArrowDown and ArrowUp on the button open it on
 *   the first and the last.
 * - In the list, the arrow keys move (wrapping, skipping disabled items), Home and End jump, Enter or Space
 *   chooses, Escape closes and gives the button focus back, and Tab closes it and moves on.
 * - A press outside closes it (`useDismiss`).
 *
 * Escape and the arrow keys stop at the menu, so a menu in a dialog or a side panel doesn't close that too.
 */
function Menu({
  label,
  trigger,
  items,
  align = "end",
  variant = "ghost",
  size = "icon-sm",
  disabled,
  className,
}: {
  /** The button's accessible name, and the list's ("More for Mentra Call"). */
  label: string;
  /** What the button shows: an icon, or words. */
  trigger: ReactNode;
  items: readonly MenuItem[];
  /** Which edge of the button the list lines up with. */
  align?: "start" | "end";
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  disabled?: boolean;
  /** Classes for the button. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Which item to focus when the list appears: the first, or the last (ArrowUp on the button).
  const landOn = useRef<"first" | "last">("first");
  const listId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(root, open, close);

  useEffect(() => {
    if (!open) return;
    const rows = list.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR);
    if (rows && rows.length > 0) (landOn.current === "last" ? rows[rows.length - 1] : rows[0])!.focus();
  }, [open]);

  const rows = () => [...(list.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
    if (!open) {
      if (arrow && event.target === button.current) {
        event.preventDefault();
        landOn.current = event.key === "ArrowDown" ? "first" : "last";
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape") {
      // Closing this menu is all Escape does: not a panel or dialog around it.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (arrow || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      const all = rows();
      if (all.length === 0) return;
      const index = all.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? all.length - 1
            : event.key === "ArrowDown"
              ? (index + 1) % all.length
              : (index - 1 + all.length) % all.length;
      all[next]!.focus();
    }
  }

  return (
    <div ref={root} data-slot="menu" className="relative inline-block" onKeyDown={onKeyDown}>
      <Button
        ref={button}
        type="button"
        variant={variant}
        size={size}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={className}
        onClick={() => {
          landOn.current = "first";
          setOpen((value) => !value);
        }}
      >
        {trigger}
      </Button>
      {open ? (
        <div
          ref={list}
          id={listId}
          role="menu"
          aria-label={label}
          className={cn(
            "rounded-menu bg-popover shadow-menu absolute top-[calc(100%+6px)] z-40 max-h-[min(70vh,520px)] min-w-52 overflow-y-auto border p-1.5",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                button.current?.focus();
                item.onSelect();
              }}
              className={cn(
                "hover:bg-hover focus-visible:bg-hover flex w-full cursor-pointer items-center gap-2.5 rounded-[12px] px-3 py-2 text-left text-sm font-semibold whitespace-nowrap focus-visible:outline-offset-[-3px] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
                item.destructive && "text-destructive",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export { Menu };
