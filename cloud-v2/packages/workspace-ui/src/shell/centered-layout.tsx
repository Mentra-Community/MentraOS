import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { MentraLogo } from "./brand";

/**
 * A page that is one focused task (the first run, an invitation): the Mentra logo and the account across
 * the top, and a single centered column on the sign-in page's plain background. It has no sidebar because
 * there is no workspace to show yet.
 */
export function CenteredLayout({
  userEmail,
  onSignOut,
  signingOut = false,
  children,
}: {
  /** Who is signed in, beside Sign out (hidden on a phone). */
  userEmail: string;
  onSignOut?: () => void;
  signingOut?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="bg-background text-foreground min-h-dvh">
      <header className="flex h-16 items-center justify-between gap-4 px-5 md:h-20 md:px-8">
        <MentraLogo className="h-[22px]" />
        <div className="flex min-w-0 items-center gap-4">
          <span className="text-muted-foreground hidden truncate text-sm sm:inline">{userEmail}</span>
          <Button type="button" variant="secondary" size="sm" disabled={signingOut} onClick={onSignOut}>
            <LogOut />
            {signingOut ? "Signing out..." : "Sign out"}
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[480px] flex-col px-5 pt-[5vh] pb-12">{children}</main>
    </div>
  );
}
