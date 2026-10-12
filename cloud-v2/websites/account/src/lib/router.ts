export type RouteName = "home" | "login" | "consent" | "signup" | "reset" | "signout" | "not-found";

const ROUTES: Readonly<Record<string, RouteName>> = {
  "/": "home",
  "/login": "login",
  "/consent": "consent",
  "/signup": "signup",
  "/reset": "reset",
  "/signout": "signout",
};

export function matchRoute(pathname: string): RouteName {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname || "/";
  return ROUTES[normalized] ?? "not-found";
}
