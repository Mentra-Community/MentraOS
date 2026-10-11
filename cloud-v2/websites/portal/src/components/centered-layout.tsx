import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import mentraLogo from "@/assets/mentra-logo.svg";
import { usePortal } from "@/lib/portal";

/**
 * A page that is one focused task (the first run, an invitation): the Mentra mark and the account across
 * the top, and a single centered column. It has no sidebar because there is no workspace to show yet.
 */
export function CenteredLayout({ children }: { children: ReactNode }) {
  const portal = usePortal();
  return (
    <div className="relative min-h-dvh overflow-hidden bg-[linear-gradient(180deg,#ffffff_0%,#f4f8f6_100%)] text-[#14151b]">
      <div className="pointer-events-none absolute left-[42%] top-[-58%] size-[980px] rounded-full bg-[radial-gradient(circle,rgba(201,244,232,0.7)_0%,rgba(228,246,240,0.4)_35%,rgba(255,255,255,0)_70%)] blur-[68px]" />
      <div className="pointer-events-none absolute left-[-24%] top-[60%] size-[720px] rounded-full bg-[radial-gradient(circle,rgba(214,242,235,0.6)_0%,rgba(232,247,242,0.35)_42%,rgba(255,255,255,0)_72%)] blur-[62px]" />

      <header className="relative flex h-16 items-center justify-between gap-4 px-5 md:px-8">
        <img src={mentraLogo} alt="Mentra" className="h-[22px] w-[41px]" />
        <div className="flex min-w-0 items-center gap-2">
          <span className="hidden truncate text-sm text-[#68746d] sm:inline">{portal.userEmail}</span>
          <button
            type="button"
            disabled={portal.signingOut}
            onClick={portal.signOut}
            className="inline-flex h-9 items-center gap-2 rounded-full px-3 text-sm font-medium text-[#5d6068] transition hover:bg-black/[0.04] hover:text-[#14151b] disabled:opacity-60"
          >
            <LogOut className="size-4" />
            {portal.signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </header>

      <main className="relative mx-auto flex w-full max-w-[480px] flex-col px-5 pb-12 pt-[4vh]">{children}</main>
    </div>
  );
}
