export type RouteName = "home" | "authorize" | "signup" | "reset" | "signout" | "not-found";

const ROUTES: Readonly<Record<string, RouteName>> = {
  "/": "home",
  "/oauth/authorize": "authorize",
  "/signup": "signup",
  "/reset": "reset",
  "/signout": "signout",
};

export function matchRoute(pathname: string): RouteName {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname || "/";
  return ROUTES[normalized] ?? "not-found";
}
