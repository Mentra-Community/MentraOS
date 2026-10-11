import { Count, WorkspaceAvatar } from "@mentra/workspace-ui";
import { Check, ChevronsUpDown, Mail, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "@/lib/navigation";
import { useDismiss } from "@/lib/use-dismiss";
import { cn } from "@/lib/utils";

export type SwitcherWorkspace = {
  workspaceId: string;
  name: string;
  /** "Owner", "Admin", …; null while unknown. */
  roleLabel: string | null;
  href: string;
};

export type SwitcherInvitation = {
  key: string;
  /** "Join Acme Field Team", or "Invitation" until the invitation has been looked up. */
  label: string;
  detail: string | null;
  href: string;
};

/**
 * The workspace switcher at the top of the sidebar: the current workspace (initial, name, your role), and
 * a menu of your workspaces, "Create workspace" and the pending invitations. Data comes in through props
 * (components/portal-shell wires the queries), so this renders the same on the server and in a test.
 */
export function WorkspaceSwitcher({
  current,
  workspaces,
  invitations,
  canCreate,
  createNotice,
  onCreate,
  listFailed = false,
  onRetry,
  defaultOpen = false,
}: {
  /** Null on pages that are not about one workspace (not found, enterprise). */
  current: SwitcherWorkspace | null;
  /** Undefined while the list loads, or when it could not be loaded (see `listFailed`). */
  workspaces: readonly SwitcherWorkspace[] | undefined;
  /** The list could not be loaded; the menu offers a retry instead of waiting. */
  listFailed?: boolean;
  onRetry?(): void;
  invitations: readonly SwitcherInvitation[];
  canCreate: boolean;
  /** Why creating is not offered, shown in its place. */
  createNotice: string | null;
  onCreate(): void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(root, open, close);

  // Opening moves focus into the menu, so the arrow keys work straight away.
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [open]);

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  const others = workspaces ?? [];

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${current ? `Workspace: ${current.name}. Switch workspace` : "Choose a workspace"}${
          invitations.length > 0 ? ` (${invitations.length} pending invitation${invitations.length === 1 ? "" : "s"})` : ""
        }`}
        onClick={() => setOpen(value => !value)}
        className={cn(
          "rounded-menu bg-background hover:bg-hover flex w-full cursor-pointer items-center gap-3 border px-2.5 py-2 text-left transition-colors",
          open && "bg-hover",
        )}
      >
        <span className="relative shrink-0">
          {current ? (
            <WorkspaceAvatar name={current.name} className="size-9 rounded-[10px] text-[15px]" />
          ) : (
            <span className="text-muted-foreground flex size-9 items-center justify-center rounded-[10px] border border-dashed">
              <ChevronsUpDown className="size-4" />
            </span>
          )}
          {invitations.length > 0 ? (
            <span aria-hidden="true" className="bg-brand ring-background absolute -top-1 -right-1 size-3 rounded-full ring-2" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] leading-5 font-semibold">
            {current ? current.name : "Choose a workspace"}
          </span>
          <span className="text-muted-foreground block truncate text-xs leading-4">
            {current
              ? (current.roleLabel ?? "\u00a0")
              : workspaces === undefined
                ? "\u00a0"
                : `${others.length} workspace${others.length === 1 ? "" : "s"}`}
          </span>
        </span>
        <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
      </button>

      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label="Workspaces"
          onKeyDown={onMenuKeyDown}
          onClick={event => {
            if (event.target instanceof Element && event.target.closest('a[role="menuitem"]')) setOpen(false);
          }}
          className="rounded-menu bg-popover shadow-menu absolute top-[calc(100%+6px)] right-0 left-0 z-40 max-h-[min(70vh,520px)] overflow-y-auto border p-1.5"
        >
          <MenuLabel>Workspaces</MenuLabel>
          {workspaces === undefined && listFailed ? (
            <div className="text-muted-foreground flex items-center justify-between gap-2 px-2 py-1.5 text-sm" role="alert">
              <span>Couldn&apos;t load your workspaces.</span>
              {onRetry ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={onRetry}
                  className="text-foreground hover:bg-hover focus-visible:bg-hover rounded-full px-3 py-1 font-semibold focus-visible:outline-offset-[-3px]"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : workspaces === undefined ? (
            <div className="text-muted-foreground px-2 py-1.5 text-sm">Loading…</div>
          ) : others.length === 0 ? (
            <div className="text-muted-foreground px-2 py-1.5 text-sm">You are not in any workspace yet.</div>
          ) : (
            others.map(workspace => {
              const selected = workspace.workspaceId === current?.workspaceId;
              return (
                <Link
                  key={workspace.workspaceId}
                  href={workspace.href}
                  role="menuitem"
                  aria-current={selected ? "true" : undefined}
                  className="flex items-center gap-2.5 hover:bg-hover focus-visible:bg-hover rounded-[12px] px-2 py-1.5 text-sm focus-visible:outline-offset-[-3px]"
                >
                  <WorkspaceAvatar name={workspace.name} className="size-8 rounded-[9px] text-sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{workspace.name}</span>
                    {workspace.roleLabel ? <span className="text-muted-foreground block truncate text-xs">{workspace.roleLabel}</span> : null}
                  </span>
                  {selected ? <Check className="text-brand size-4 shrink-0" aria-label="Current workspace" /> : null}
                </Link>
              );
            })
          )}

          <MenuSeparator />
          {canCreate ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 text-left font-semibold hover:bg-hover focus-visible:bg-hover rounded-[12px] px-2 py-1.5 text-sm focus-visible:outline-offset-[-3px]"
            >
              <span className="text-muted-foreground flex size-8 items-center justify-center rounded-[9px] border border-dashed">
                <Plus className="size-4" />
              </span>
              Create workspace
            </button>
          ) : (
            <div role="menuitem" aria-disabled="true" className="flex items-start gap-2.5 rounded-[12px] px-2 py-1.5 text-sm">
              <span className="text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-dashed opacity-45">
                <Plus className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="text-muted-foreground block font-semibold">Create workspace</span>
                {createNotice ? <span className="text-muted-foreground block text-xs leading-4">{createNotice}</span> : null}
              </span>
            </div>
          )}

          {invitations.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuLabel>
                Pending invitations
                <Count className="ml-2">{invitations.length}</Count>
              </MenuLabel>
              {invitations.map(invitation => (
                <Link
                  key={invitation.key}
                  href={invitation.href}
                  role="menuitem"
                  className="flex items-center gap-2.5 hover:bg-hover focus-visible:bg-hover rounded-[12px] px-2 py-1.5 text-sm focus-visible:outline-offset-[-3px]"
                >
                  <span className="bg-info text-info-foreground flex size-8 shrink-0 items-center justify-center rounded-[9px]">
                    <Mail className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{invitation.label}</span>
                    {invitation.detail ? <span className="text-muted-foreground block truncate text-xs">{invitation.detail}</span> : null}
                  </span>
                </Link>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex items-center px-2 pt-1.5 pb-1 text-xs font-semibold">{children}</div>
  );
}

function MenuSeparator() {
  return <div role="separator" className="bg-border -mx-1.5 my-1.5 h-px" />;
}
