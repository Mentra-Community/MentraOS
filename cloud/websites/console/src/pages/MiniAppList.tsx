// pages/MiniAppList.tsx
import { useEffect, useMemo } from "react";
import { Button } from "@mentra/shared";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import DashboardLayout from "../components/DashboardLayout";
import MiniAppTable from "../components/MiniAppTable";
import { useOrgStore } from "@/stores/orgs.store";
import { useAppStore } from "@/stores/apps.store";
import type { AppResponse } from "@/services/api.service";

const DEBUG = false;

const MiniAppList: React.FC = () => {
  const navigate = useNavigate();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);

  const list = useAppStore((s) => s.list);
  const appsByPackage = useAppStore((s) => s.appsByPackage);
  const loading = useAppStore((s) => s.loading);
  const error = useAppStore((s) => s.error);
  const fetchApps = useAppStore((s) => s.fetchApps);

  const apps = useMemo(
    () =>
      list.map((pkg) => appsByPackage[pkg]).filter(Boolean) as AppResponse[],
    [list, appsByPackage],
  );

  // Fetch Apps when org selection changes
  useEffect(() => {
    // Debug logs to verify effect triggers on org change
    console.log("[MiniAppList] effect:orgChange", { selectedOrgId });
    if (selectedOrgId) {
      console.log("[MiniAppList] fetchApps call", { selectedOrgId });
      fetchApps({ orgId: selectedOrgId });
    }
  }, [selectedOrgId, fetchApps]);

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-foreground">My MiniApps</h1>
          <Button className="gap-2" onClick={() => navigate("/apps/create")}>
            <Plus className="h-4 w-4" />
            Create MiniApp
          </Button>
        </div>

        {/* Debug summary for troubleshooting */}
        {DEBUG && (
          <div className="text-xs text-muted-foreground mb-2">
            <pre className="whitespace-pre-wrap">
              {JSON.stringify(
                {
                  selectedOrgId,
                  count: apps.length,
                  loading,
                  hasError: !!error,
                },
                null,
                2,
              )}
            </pre>
          </div>
        )}

        <MiniAppTable
          apps={apps}
          isLoading={loading}
          error={error}
          showSearch={true}
          showViewAll={false}
        />
      </div>
    </DashboardLayout>
  );
};

export default MiniAppList;
