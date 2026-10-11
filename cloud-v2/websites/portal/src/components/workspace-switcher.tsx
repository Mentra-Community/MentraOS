import { initials } from "@mentra/workspace-ui";
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
          "flex w-full items-center gap-3 rounded-[12px] border border-[#e4e6e2] bg-white px-2.5 py-2 text-left shadow-[0_1px_2px_rgba(20,21,27,0.04)] transition-colors hover:bg-[#f7f8f6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#36dd89]/60",
          open && "bg-[#f7f8f6]",
        )}
      >
        <span className="relative shrink-0">
          {current ? (
            <WorkspaceAvatar name={current.name} className="size-9 rounded-[10px] text-[15px]" />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-[10px] border border-dashed border-[#cfd5cd] text-[#a0a3aa]">
              <ChevronsUpDown className="size-4" />
            </span>
          )}
          {invitations.length > 0 ? (
            <span aria-hidden="true" className="absolute -right-1 -top-1 size-3 rounded-full bg-[#36dd89] ring-2 ring-white" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold leading-5 text-[#14151b]">
            {current ? current.name : "Choose a workspace"}
          </span>
          <span className="block truncate text-[12px] leading-4 text-[#8a8d95]">
            {current
              ? (current.roleLabel ?? "\u00a0")
              : workspaces === undefined
                ? "\u00a0"
                : `${others.length} workspace${others.length === 1 ? "" : "s"}`}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-[#a0a3aa]" />
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
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 max-h-[min(70vh,520px)] overflow-y-auto rounded-[14px] border border-[#e0e4de] bg-white p-1.5 shadow-[0_16px_40px_-12px_rgba(20,21,27,0.28)]"
        >
          <MenuLabel>Workspaces</MenuLabel>
          {workspaces === undefined && listFailed ? (
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm text-[#8a8d95]" role="alert">
              <span>Couldn&apos;t load your workspaces.</span>
              {onRetry ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={onRetry}
                  className="rounded-[8px] px-2 py-1 font-medium text-[#14151b] outline-none hover:bg-[#f3f4f2] focus-visible:bg-[#f3f4f2]"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : workspaces === undefined ? (
            <div className="px-2 py-1.5 text-sm text-[#8a8d95]">Loading…</div>
          ) : others.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-[#8a8d95]">You are not in any workspace yet.</div>
          ) : (
            others.map(workspace => {
              const selected = workspace.workspaceId === current?.workspaceId;
              return (
                <Link
                  key={workspace.workspaceId}
                  href={workspace.href}
                  role="menuitem"
                  aria-current={selected ? "true" : undefined}
                  className="flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-sm outline-none hover:bg-[#f3f4f2] focus-visible:bg-[#f3f4f2]"
                >
                  <WorkspaceAvatar name={workspace.name} className="size-7 rounded-[8px] text-xs" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-[#14151b]">{workspace.name}</span>
                    {workspace.roleLabel ? <span className="block truncate text-xs text-[#8a8d95]">{workspace.roleLabel}</span> : null}
                  </span>
                  {selected ? <Check className="size-4 shrink-0 text-[#087d50]" aria-label="Current workspace" /> : null}
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
              className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left text-sm font-medium text-[#14151b] outline-none hover:bg-[#f3f4f2] focus-visible:bg-[#f3f4f2]"
            >
              <span className="flex size-7 items-center justify-center rounded-[8px] border border-dashed border-[#cfd5cd] text-[#5d6068]">
                <Plus className="size-4" />
              </span>
              Create workspace
            </button>
          ) : (
            <div role="menuitem" aria-disabled="true" className="flex items-start gap-2.5 rounded-[10px] px-2 py-1.5 text-sm">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-dashed border-[#e0e4de] text-[#c0c3c8]">
                <Plus className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block font-medium text-[#a0a3aa]">Create workspace</span>
                {createNotice ? <span className="block text-xs leading-4 text-[#8a8d95]">{createNotice}</span> : null}
              </span>
            </div>
          )}

          {invitations.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuLabel>
                Pending invitations
                <span className="ml-1.5 rounded-full bg-[#e9f8f1] px-1.5 py-0.5 text-[10px] font-semibold text-[#087d50]">
                  {invitations.length}
                </span>
              </MenuLabel>
              {invitations.map(invitation => (
                <Link
                  key={invitation.key}
                  href={invitation.href}
                  role="menuitem"
                  className="flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-sm outline-none hover:bg-[#f3f4f2] focus-visible:bg-[#f3f4f2]"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-[#e9f8f1] text-[#087d50]">
                    <Mail className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-[#14151b]">{invitation.label}</span>
                    {invitation.detail ? <span className="block truncate text-xs text-[#8a8d95]">{invitation.detail}</span> : null}
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

/** A workspace's initial on a tinted square, in place of a logo. */
export function WorkspaceAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center bg-[linear-gradient(135deg,#e9f8f1_0%,#c9f4e0_100%)] font-display font-bold text-[#087d50] ring-1 ring-inset ring-[#087d50]/10",
        className,
      )}
    >
      {initials(name).slice(0, 1)}
    </span>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#a0a3aa]">{children}</div>
  );
}

function MenuSeparator() {
  return <div role="separator" className="-mx-1.5 my-1.5 h-px bg-[#eceeeb]" />;
}
