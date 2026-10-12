import { buttonVariants } from "@mentra/workspace-ui";
import { BrandPage } from "./brand";

/**
 * After signing out of the workspace portal. The workspace portal session has ended;
 * the person may still be signed in to Mentra on this browser, at Core's
 * sign-in server, so its sign-out (the end-session endpoint) is offered as a
 * separate link when Core provides one: that
 * is how a person switches accounts. Signing in again returns to `signInHref`
 * (the pending invitation, when one is waiting for the other account).
 */
export function SignedOutScreen({ signOutUrl, signInHref = "/" }: { signOutUrl: string | null; signInHref?: string }) {
  return (
    <BrandPage title="Signed out of the workspace portal">
      <p className="text-muted-foreground mb-7">
        {signOutUrl
          ? "Your Mentra account is still signed in on this browser. Sign out of it too, for example to switch accounts."
          : "You can close this tab."}
      </p>
      <div className="flex flex-col gap-3">
        {signOutUrl ? (
          <a className={buttonVariants({ size: "lg", className: "w-full" })} href={signOutUrl}>
            Sign out of your Mentra account
          </a>
        ) : null}
        <a className={buttonVariants({ variant: "secondary", size: "lg", className: "w-full" })} href={signInHref}>
          Sign in again
        </a>
      </div>
    </BrandPage>
  );
}
