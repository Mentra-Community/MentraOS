import { Button } from "@mentra/workspace-ui";
import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { MentraLogo } from "@/components/brand";
import { usePortal } from "@/lib/portal";

/**
 * A page that is one focused task (the first run, an invitation): the Mentra logo and the account across
 * the top, and a single centered column on the sign-in page's plain background. It has no sidebar because
 * there is no workspace to show yet.
 */
export function CenteredLayout({ children }: { children: ReactNode }) {
  const portal = usePortal();
  return (
    <div className="bg-background text-foreground min-h-dvh">
      <header className="flex h-16 items-center justify-between gap-4 px-5 md:h-20 md:px-8">
        <MentraLogo className="h-[22px]" />
        <div className="flex min-w-0 items-center gap-4">
          <span className="text-muted-foreground hidden truncate text-sm sm:inline">{portal.userEmail}</span>
          <Button type="button" variant="secondary" size="sm" disabled={portal.signingOut} onClick={portal.signOut}>
            <LogOut />
            {portal.signingOut ? "Signing out..." : "Sign out"}
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[480px] flex-col px-5 pt-[5vh] pb-12">{children}</main>
    </div>
  );
}
