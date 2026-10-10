import { useEffect, useState } from "react";
import type { AccountAuthClient } from "../lib/supabase";
import { Loading, Page } from "../ui";

type HomeState = { kind: "loading" } | { kind: "signed-out" } | { kind: "signed-in"; email: string };

/** `/`: shows whether this browser is signed in to a Mentra account. */
export function HomeRoute({ auth }: { auth: AccountAuthClient }) {
  const [state, setState] = useState<HomeState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        setState(data.session ? { kind: "signed-in", email: data.session.user.email ?? "" } : { kind: "signed-out" });
      })
      .catch(() => {
        if (active) setState({ kind: "signed-out" });
      });
    return () => {
      active = false;
    };
  }, [auth]);

  if (state.kind === "loading") return <Loading label="Loading…" />;
  return <HomeView state={state} />;
}

export function HomeView({ state }: { state: Exclude<HomeState, { kind: "loading" }> }) {
  if (state.kind === "signed-out") {
    return (
      <Page title="Mentra account">
        <p className="muted">To sign in, start from the Mentra site or app you want to use.</p>
      </Page>
    );
  }
  return (
    <Page title="Mentra account">
      <p className="muted">
        {state.email ? (
          <>
            You are signed in as <strong>{state.email}</strong>.
          </>
        ) : (
          "You are signed in."
        )}
      </p>
      <nav className="links" aria-label="Account">
        <a href="/signout">Sign out</a>
      </nav>
    </Page>
  );
}
