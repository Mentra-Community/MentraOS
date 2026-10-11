import { useEffect, useRef, useState } from "react";
import { signOutLocally } from "../lib/account-actions";
import type { AccountAuthClient } from "../lib/supabase";
import { Loading, Page } from "../ui";

/**
 * `/signout`: ends this site's Mentra session.
 *
 * This uses `signOut({scope: "local"})` (through `signOutLocally`) and never
 * `signOut()`: the default scope is global, which would end the session of
 * every other Mentra site and the CLI for this account.
 */
export function SignOutRoute({ auth }: { auth: AccountAuthClient }) {
  const [done, setDone] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void signOutLocally(auth).then(() => setDone(true));
  }, [auth]);

  if (!done) return <Loading label="Signing out…" />;
  return <SignedOutView />;
}

export function SignedOutView() {
  return (
    <Page title="Signed out of Mentra">
      <p className="muted">You are signed out of your Mentra account on this site.</p>
    </Page>
  );
}
