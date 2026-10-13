import { useEffect, useRef } from "react";
import { END_SESSION_PATH } from "../lib/links";
import { Loading } from "../ui";

/**
 * `/signout`: signs this browser out of Mentra on this environment's sign-in
 * site, at Core's sign-in server's end-session endpoint (which asks to
 * confirm). Sites and the CLI the person is signed in to stay signed in until
 * they sign out of them.
 */
export function SignOutRoute({ navigate }: { navigate: (url: string) => void }) {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    navigate(END_SESSION_PATH);
  }, [navigate]);
  return <Loading label="Signing out…" />;
}
