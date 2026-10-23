import { Page } from "../ui";

/** `/`: the sign-in site's root. Signing in always starts from the site or app the person uses. */
export function HomeRoute() {
  return (
    <Page title="Mentra account">
      <p className="muted">To sign in, start from the Mentra site or app you want to use.</p>
      <nav className="links" aria-label="Account">
        <a href="/signout">Sign out of Mentra on this browser</a>
      </nav>
    </Page>
  );
}
