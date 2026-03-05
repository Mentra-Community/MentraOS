// pages/DashboardHome.tsx
import { useMemo } from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@mentra/shared";
import { PlusIcon } from "lucide-react";
import { Link } from "react-router-dom";
import DashboardLayout from "../components/DashboardLayout";
import MiniAppTable from "../components/MiniAppTable";
// import { useOrgStore } from "@/stores/orgs.store";
import { useAppStore } from "@/stores/apps.store";
import type { AppResponse } from "@/services/api.service";

const DashboardHome: React.FC = () => {
  // const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const list = useAppStore((s) => s.list);
  const appsByPackage = useAppStore((s) => s.appsByPackage);
  const loading = useAppStore((s) => s.loading);
  const error = useAppStore((s) => s.error);

  const apps = useMemo(
    () =>
      list.map((pkg) => appsByPackage[pkg]).filter(Boolean) as AppResponse[],
    [list, appsByPackage],
  );
  // Removed dialog states as they're now handled by the AppTable component

  // Using cached apps from apps.store; no refetch on org change
  // const hasNoApps = apps.length === 0 && !loading && !error;

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
          <Button className="gap-2" asChild>
            <Link to="/apps/create">
              <PlusIcon className="h-4 w-4" />
              Create MiniApp
            </Link>
          </Button>
        </div>

        {/* Documentation card - always shown */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 mb-6">
          <Card className="col-span-1 lg:col-span-3">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Getting Started</CardTitle>
              <CardDescription>
                Learn how to build MiniApps for MentraOS
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                Welcome to the MentraOS Developer Portal! Here, you can create
                and manage your MiniApps for the MentraOS smart glasses platform.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border rounded-md p-4">
                  <h3 className="font-medium mb-2">Quick Start Guide</h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    Learn how to build your first MentraOS MiniApp in minutes.
                  </p>
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href="https://docs.mentra.glass"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View Guide
                    </a>
                  </Button>
                </div>
                <div className="border rounded-md p-4">
                  <h3 className="font-medium mb-2">API Documentation</h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    Explore the full MentraOS API reference.
                  </p>
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href="https://docs.mentra.glass"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View API Docs
                    </a>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* MiniApps Section */}
        <MiniAppTable
          apps={apps}
          isLoading={loading}
          error={error}
          maxDisplayCount={3}
          showSearch={true}
          showViewAll={true}
        />
      </div>

      {/* Dialogs now handled by AppTable component */}
    </DashboardLayout>
  );
};

export default DashboardHome;
