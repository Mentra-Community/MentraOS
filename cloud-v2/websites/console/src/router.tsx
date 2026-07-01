import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { LoginPage } from "@/components/login-page";
import { OrganizationSelectionPage } from "@/components/organization-selection-page";
import { AppsPage } from "@/features/apps/apps-page";
import { MiniappDetailPage } from "@/features/apps/miniapp-detail-page";
import { DashboardPage } from "@/features/dashboard/dashboard-page";
import { InviteAcceptPage } from "@/features/org/invite-accept-page";
import { OrganizationPage } from "@/features/org/organization-page";
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

const organizationSelectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/select-organization",
  component: OrganizationSelectionPage,
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

const miniappDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/apps/$packageName",
  component: MiniappDetailPage,
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

const inviteAcceptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: InviteAcceptPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  organizationSelectionRoute,
  dashboardRoute,
  appsRoute,
  miniappDetailRoute,
  tokensRoute,
  organizationRoute,
  inviteAcceptRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
