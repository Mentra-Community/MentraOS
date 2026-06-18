import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { LoginPage } from "@/components/login-page";
import { AppsPage } from "@/features/apps/apps-page";
import { DashboardPage } from "@/features/dashboard/dashboard-page";
import { OrganizationPage } from "@/features/org/organization-page";
import { PublishPage } from "@/features/publish/publish-page";
import { TokensPage } from "@/features/tokens/tokens-page";

function RootLayout() {
  return <Outlet />;
}

const rootRoute = createRootRoute({
  component: RootLayout,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LoginPage,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: DashboardPage,
});

const appsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/apps",
  component: AppsPage,
});

const publishRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/publish",
  component: PublishPage,
});

const tokensRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tokens",
  component: TokensPage,
});

const organizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organization",
  component: OrganizationPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  dashboardRoute,
  appsRoute,
  publishRoute,
  tokensRoute,
  organizationRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
