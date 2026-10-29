import { BrandPage, buttonVariants } from "@mentra/workspace-ui";

/**
 * After signing out of the workspace portal when Core gave no Mentra account sign-out to go to (lib/session): the
 * portal session has ended and there is nothing else to do here. Signing in again returns to `signInHref` (the
 * pending invitation, when one is waiting).
 */
export function SignedOutScreen({ signInHref = "/" }: { signInHref?: string }) {
  return (
    <BrandPage title="Signed out of Mentra Portal">
      <p className="text-muted-foreground mb-7">You can close this tab.</p>
      <a className={buttonVariants({ size: "lg", className: "w-full" })} href={signInHref}>
        Sign in again
      </a>
    </BrandPage>
  );
}
