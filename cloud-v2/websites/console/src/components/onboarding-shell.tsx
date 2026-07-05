import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import mentraLogo from "@/assets/mentra-logo.svg";

/**
 * Nav-free shell for the onboarding gate. Unlike AppShell it has no sidebar and
 * no route links — a developer with no org cannot wander into Home/Miniapps/etc.
 * and bounce off a dead redirect. Only branding + sign-out, with the onboarding
 * step front and center. Mirrors the portal's FocusShell.
 */
export function OnboardingShell({
  userLabel,
  onSignOut,
  signingOut,
  children,
}: {
  userLabel: string;
  onSignOut: () => void;
  signingOut?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-[#f5f6f4] text-[#14151b]">
      <header className="border-b border-[#e4e6e2] bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5">
          <div className="flex items-center gap-3">
            <img src={mentraLogo} alt="" className="h-[22px] w-[41px]" />
            <div className="min-w-0">
              <div className="font-display text-[15px] font-bold leading-5 text-[#14151b]">Dev Console</div>
              <div className="truncate text-xs leading-4 text-muted-foreground">MentraOS{userLabel ? ` · ${userLabel}` : ""}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            className="flex shrink-0 items-center gap-2 rounded-full border border-[#e0e4de] px-4 py-2 text-sm font-medium text-[#5d6068] hover:bg-[#f3f4f2] disabled:opacity-60"
          >
            <LogOut className="size-4" />
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-10">{children}</main>
    </div>
  );
}
