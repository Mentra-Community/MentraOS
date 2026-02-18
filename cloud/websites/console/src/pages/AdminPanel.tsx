// pages/AdminPanel.tsx
import React, { useState, useEffect } from "react";
import DashboardLayout from "../components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Search } from "@/components/ui/search";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useNavigate } from "react-router-dom";
import {
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  Package,
  Smartphone,
  X,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import api from "../services/api.service";
import { StatusBadge, UptimeStatus } from "@/components/ui/upTime";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import axios from "axios";
import AppDetailView from "./AppUptime";
interface AdminStat {
  counts: {
    development: number;
    submitted: number;
    published: number;
    rejected: number;
    admins: number;
  };
  recentSubmissions: any[];
}

// Admin user interface removed

interface AppBatchItem {
  packageName: string;
  timestamp: string;
  health: string;
  onlineStatus: boolean;
}

interface AppDetail {
  _id: string;
  packageName: string;
  name: string;
  description: string;
  developerId?: string; // Mark as optional as we're transitioning away from it
  organization?: {
    id: string;
    name: string;
    profile?: {
      contactEmail?: string;
      website?: string;
      description?: string;
    };
  };
  logoURL: string;
  appStoreStatus: string;
  createdAt: string;
  updatedAt: string;
  reviewNotes?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  // Extended fields available from the admin app detail endpoint
  publicUrl?: string;
  webviewURL?: string;
  tools?: Array<{
    id: string;
    description: string;
    activationPhrases?: string[];
    parameters?: Record<
      string,
      {
        type: string;
        description: string;
        enum?: string[];
        required?: boolean;
      }
    >;
  }>;
  settings?: Array<{
    type: string;
    key?: string;
    label?: string;
    title?: string;
    defaultValue?: unknown;
    value?: unknown;
    options?: Array<{ label: string; value: unknown }>;
    min?: number;
    max?: number;
    maxLines?: number;
  }>;
  permissions?: Array<{
    type: string;
    description?: string;
  }>;
  hardwareRequirements?: Array<{
    type: string;
    level: string;
    description?: string;
  }>;
}

const AdminPanel: React.FC = () => {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  // Empty initial state - will be filled with real data from API
  const [stats, setStats] = useState<AdminStat>({
    counts: {
      development: 0,
      submitted: 0,
      published: 0,
      rejected: 0,
      admins: 0,
    },
    recentSubmissions: [],
  });
  const [submittedApps, setSubmittedApps] = useState<any[]>([]);
  const [submittedAppsStatus, setSubmittedAppsStatus] = useState<any[]>([]);
  const [collectedAllAppBatchStatus, setCollectedAllAppBatchStatus] = useState<
    AppBatchItem[]
  >([]);

  /* Admin management removed */
  const [selectedApp, setSelectedApp] = useState<AppDetail | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");

  const [openReviewDialog, setOpenReviewDialog] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  // Install/uninstall state for the selected app in the review dialog
  const [isInstalling, setIsInstalling] = useState(false);
  const [isInstalledForUser, setIsInstalledForUser] = useState<boolean | null>(
    null,
  );
  // Collapsible sections state (collapsed by default)
  const [showTools, setShowTools] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [lastUpdateTime, setLastUpdateTime] = useState<Date | null>(null);

  // Active tab state to replace the shadcn Tabs component
  const [activeTab, setActiveTab] = useState("dashboard");
  const [chosenAppStatus, setChosenAppStatus] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Get todays date:
  const today = new Date();
  const monthNumber = today.getMonth(); // Months are 0-indexed in JavaScript
  const year = today.getFullYear();

  const [monthNumberDynamic, setMonthNumberDynamic] = useState(monthNumber);
  const [yearNumber, setYearNumber] = useState(year);
  const START_UPTIME_MONTH = 7; // August (0-indexed)
  const START_UPTIME_YEAR = 2025; // Starting year for uptime data

  // Month navigation functions for DatePicker
  const handlePrevMonth = () => {
    let newMonth = monthNumberDynamic - 1;
    let newYear = yearNumber;

    if (newMonth < 0) {
      newMonth = 11;
      newYear = yearNumber - 1;
    }
    // if (newYear < START_UPTIME_YEAR || (newYear === START_UPTIME_YEAR && newMonth < START_UPTIME_MONTH)) {
    //   return; // Don't allow navigation before start date
    // }
    setMonthNumberDynamic(newMonth);
    setYearNumber(newYear);
  };

  const handleNextMonth = () => {
    let newMonth = monthNumberDynamic + 1;
    let newYear = yearNumber;

    if (newMonth > 11) {
      newMonth = 0;
      newYear = yearNumber + 1;
    }

    setMonthNumberDynamic(newMonth);
    setYearNumber(newYear);
  };

  // Polling for app status updates
  useEffect(() => {
    const fetchData = async () => {
      // Fetch immediately
      await fetchAppStatus();
    };
    fetchData();
  }, []);

  // When the current month and year are set
  useEffect(() => {
    const fetchData = async () => {
      await fetchCollectedAllAppBatchStatus(monthNumberDynamic, yearNumber);
    };
    fetchData();
  }, [monthNumberDynamic, yearNumber]);

  const fetchAppStatus = async () => {
    try {
      setStatusLoading(true);
      const res = await axios.get("/api/app-uptime/status", {
        headers: { "Content-Type": "application/json" },
      });

      if (res.data.apps) {
        setSubmittedAppsStatus(res.data.apps);
      }

      // Set the last update time
      setLastUpdateTime(new Date());
    } catch (error) {
      console.error("Error fetching app status:", error);
    } finally {
      setStatusLoading(false);
    }
  };

  // Function to update the day bar based on app items
  const fetchCollectedAllAppBatchStatus = async (
    month: number,
    year: number,
  ) => {
    const adjustedMonth = month + 1; // Adjust month to 1-indexed for API
    try {
      setStatusLoading(true);
      const res = await axios.get(
        `/api/app-uptime/get-app-uptime-days?month=${adjustedMonth}&year=${year}`,
        {
          headers: { "Content-Type": "application/json" },
        },
      );
      // console.log('Status response testing?ggs:', res.data);

      if (res.data.data) {
        // Transform data into nested structure grouped by packageName and date
        const groupedData = res.data.data.reduce(
          (acc: Record<string, Record<string, any[]>>, entry: any) => {
            const packageName = entry.packageName;
            const dateKey = new Date(entry.timestamp)
              .toISOString()
              .split("T")[0]; // YYYY-MM-DD format

            // Initialize package group if it doesn't exist
            if (!acc[packageName]) {
              acc[packageName] = {};
            }

            // Initialize date array if it doesn't exist
            if (!acc[packageName][dateKey]) {
              acc[packageName][dateKey] = [];
            }

            // Add entry to the appropriate date array
            acc[packageName][dateKey].push(entry);

            return acc;
          },
          {},
        );

        // Sort entries within each date array by timestamp (newest first)
        Object.keys(groupedData).forEach((packageName) => {
          Object.keys(groupedData[packageName]).forEach((date) => {
            groupedData[packageName][date].sort(
              (a: any, b: any) =>
                new Date(b.timestamp).getTime() -
                new Date(a.timestamp).getTime(),
            );
          });
        });

        setCollectedAllAppBatchStatus({ ...res.data, data: groupedData });
      }

      // Set the last update time
      setLastUpdateTime(new Date());
    } catch (error) {
      console.error("Error fetching app status:", error);
    } finally {
      setStatusLoading(false);
    }
  };

  // Load admin data when component mounts
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Wait for token to be ready
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Log the authentication state
        const token = localStorage.getItem("core_token");
        const email = localStorage.getItem("userEmail");
        console.log("Admin panel auth info:", {
          hasToken: !!token,
          tokenLength: token?.length,
          email: email,
        });

        // Load the admin data
        await loadAdminData();
      } catch (err) {
        console.error("Error in admin data initialization:", err);
      }
    };

    fetchData();
  }, []);

  // Check if user is admin and load data TODO may have to look it over with Issiah Claude was helping me here
  const loadAdminData = async () => {
    setIsLoading(true);

    try {
      console.log("Loading admin data...");

      // Use the admin API service
      // Use a fallback to mock data if API requests fail
      let statsData = null;
      let appsData = [];

      try {
        // Stats request
        statsData = await api.admin.getStats();
        console.log("Stats data loaded:", statsData);
      } catch (err) {
        console.error("Error fetching stats:", err);
      }

      try {
        // Submitted apps request
        appsData = await api.admin.getSubmittedApps();
        console.log("Submitted apps loaded:", appsData.length);
      } catch (err) {
        console.error("Error fetching submitted apps:", err);
      }

      console.log("Updating state with API data:", {
        hasStats: !!statsData,
        submittedAppsCount: appsData?.length || 0,
      });

      // Always update with real data, even if empty
      if (statsData) {
        // Add health status to recent submissions if they exist
        if (
          statsData.recentSubmissions &&
          statsData.recentSubmissions.length > 0
        ) {
          const recentWithHealth = await addAppHealthStatus(
            statsData.recentSubmissions,
          );
          setStats({
            ...statsData,
            recentSubmissions: recentWithHealth,
          });
        } else {
          setStats(statsData);
        }
      } else {
        // If stats failed but we have app data, create a minimal stats object
        if (appsData) {
          const submittedCount = appsData.length;
          const recentWithHealth = await addAppHealthStatus(
            appsData.slice(0, 3),
          );
          setStats({
            counts: {
              development: 0,
              submitted: submittedCount,
              published: 0,
              rejected: 0,
              admins: 0, // Admin count not needed
            },
            recentSubmissions: recentWithHealth,
          });
        }
      }

      // Add health status and update state with real data
      console.log(
        "Setting real submitted apps data, count:",
        appsData?.length || 0,
      );
      setSubmittedApps(appsData || []);
    } catch (error) {
      console.error("Error loading admin data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // Function to add health status to apps
  async function addAppHealthStatus(submittedApps: any[]) {
    if (!submittedApps || submittedApps.length === 0) return submittedApps;

    const updatedApps = [...submittedApps];

    for (let i = 0; i < updatedApps.length; i++) {
      const cloudApp = updatedApps[i];
      const publicUrl = cloudApp.publicUrl;

      try {
        const res = await axios.get(
          `/api/app-uptime/ping?url=${encodeURIComponent(publicUrl + "/health")}`,
          {
            timeout: 10000,
          },
        );

        if (res.data.success && res.data.status === 200) {
          const healthData = res.data.data;

          if (healthData && healthData.status === "healthy") {
            // console.log(`✅ ${healthData.app || cloudApp.name} is healthy`);
            updatedApps[i] = { ...cloudApp, appHealthStatus: "healthy" };
          } else {
            // console.log(`❌ ${cloudApp.name} responded but not healthy`);
            updatedApps[i] = { ...cloudApp, appHealthStatus: "unhealthy" };
          }
        } else {
          // console.warn(`Skipping ${publicUrl} - Not reachable`);
          updatedApps[i] = { ...cloudApp, appHealthStatus: "unreachable" };
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          if (error.code === "ECONNABORTED") {
            // console.warn(`Skipping ${publicUrl} - Request timeout`);
            updatedApps[i] = { ...cloudApp, appHealthStatus: "timeout" };
          } else {
            // console.warn(`Skipping ${publicUrl} - Network error:`, error.message);
            updatedApps[i] = { ...cloudApp, appHealthStatus: "error" };
          }
        } else {
          // console.warn(`Skipping ${publicUrl} - Unknown error:`, error);
          updatedApps[i] = { ...cloudApp, appHealthStatus: "error" };
        }
        continue;
      }
    }

    return updatedApps;
  }

  // Ui doodoo
  /**
   * Open the app review dialog by fetching full app details and
   * checking whether the app is installed for the current user.
   */
  const openAppReview = async (packageName: string) => {
    try {
      const appData = await api.admin.getAppDetail(packageName);
      setSelectedApp(appData);
      setReviewNotes("");
      setOpenReviewDialog(true);
      // Reset collapsibles to default collapsed state on open
      setShowTools(false);
      setShowSettings(false);

      // Determine installation status for the logged-in user
      try {
        const installed = await api.userApps.getInstalledApps();
        const isInstalled = Array.isArray(installed)
          ? installed.some((app: any) => app.packageName === packageName)
          : false;
        setIsInstalledForUser(isInstalled);
      } catch (err) {
        console.error("Failed to fetch installed apps for user:", err);
        setIsInstalledForUser(null);
      }
    } catch (error) {
      console.error("Error loading app details:", error);
      alert("Error loading app details. Please try again.");
    }
  };

  const handleApprove = async () => {
    if (!selectedApp) return;

    setActionLoading(true);
    try {
      await api.admin.approveApp(selectedApp.packageName, reviewNotes);

      // Refresh data
      loadAdminData();
      setOpenReviewDialog(false);
      alert("App approved successfully!");
    } catch (error) {
      console.error("Error approving app:", error);
      alert("Failed to approve app. Please try again.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!selectedApp || !reviewNotes.trim()) return;

    setActionLoading(true);
    try {
      await api.admin.rejectApp(selectedApp.packageName, reviewNotes);

      // Refresh data
      loadAdminData();
      setOpenReviewDialog(false);
      alert("App rejected. Developer has been notified.");
    } catch (error) {
      console.error("Error rejecting app:", error);
      alert("Failed to reject app. Please try again.");
    } finally {
      setActionLoading(false);
    }
  };

  /**
   * Install or uninstall the currently selected app for the logged-in user.
   */
  const handleInstallToggle = async () => {
    if (!selectedApp || isInstalling) return;
    setIsInstalling(true);
    try {
      if (isInstalledForUser) {
        const ok = await api.userApps.uninstallApp(selectedApp.packageName);
        if (ok) {
          setIsInstalledForUser(false);
          alert("App uninstalled for current user");
        } else {
          alert("Failed to uninstall app for current user");
        }
      } else {
        const ok = await api.userApps.installApp(selectedApp.packageName);
        if (ok) {
          setIsInstalledForUser(true);
          alert("App installed for current user");
        } else {
          alert("Failed to install app for current user");
        }
      }
    } catch (err) {
      console.error("Install/uninstall error:", err);
      alert("Operation failed. See console for details.");
    } finally {
      setIsInstalling(false);
    }
  };

  /* Admin management functions removed */
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Filter apps based on search query
  const filteredApps = submittedApps.filter((app) => {
    if (!searchQuery.trim()) return true;

    const query = searchQuery.toLowerCase();
    return (
      app.name.toLowerCase().includes(query) ||
      app.packageName.toLowerCase().includes(query)
    );
  });

  // Function to check API connectivity
  const checkApiConnection = async () => {
    try {
      const authToken = localStorage.getItem("core_token");
      console.log("Checking API with token:", {
        hasToken: !!authToken,
        tokenLength: authToken?.length,
      });

      // Try the debug endpoint that doesn't require admin auth
      const data = await api.admin.debug();
      console.log("API debug response:", data);

      alert(
        "API connection successful!\n\n" +
          `Status: ${data.status}\n` +
          `Time: ${data.time}\n` +
          `Total apps: ${data.counts?.apps?.total || 0}\n` +
          `Submitted apps: ${data.counts?.apps?.submitted || 0}\n` +
          `Admins: ${data.counts?.admins || 0}`,
      );

      // If there are no admins, suggest creating one
      if (!data.counts?.admins || data.counts.admins === 0) {
        const createAdmin = confirm(
          "No admin users found. Would you like to create a default admin user?",
        );
        if (createAdmin) {
          // Try to create default admin
          const email =
            localStorage.getItem("userEmail") || prompt("Enter admin email:");
          if (email) {
            try {
              const apiUrl =
                import.meta.env.VITE_API_URL || "http://localhost:8002";
              const createResponse = await fetch(
                `${apiUrl}/api/admin/bootstrap-admin`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ email, key: "dev-mode" }),
                },
              );

              if (createResponse.ok) {
                alert(`Admin user ${email} created!`);
              } else {
                alert("Failed to create admin user");
              }
            } catch (err) {
              console.error("Error creating admin user:", err);
              alert("Failed to create admin user");
            }
          }
        }
      }
    } catch (error) {
      console.error("API debug check failed:", error);
      alert(
        "Error connecting to API: " +
          ((error as Error).message || "Unknown error"),
      );
    }
  };

  // Function to get app batch status by package name
  const getAppBatchStatusByPackageName = (
    collectedData: any,
    packageName: string,
  ): AppBatchItem[] => {
    // Check if collectedData exists and has the data object
    if (
      !collectedData ||
      !collectedData.data ||
      typeof collectedData.data !== "object"
    ) {
      return [];
    }

    // Get the package data from the nested structure
    const packageData = collectedData.data[packageName];
    if (!packageData) {
      console.log(`No data found for package: ${packageName}`);
      return [];
    }

    // Flatten all entries from all dates for this package
    const allEntries: AppBatchItem[] = [];
    Object.values(packageData).forEach((dateEntries: any) => {
      if (Array.isArray(dateEntries)) {
        allEntries.push(...dateEntries);
      }
    });

    return allEntries;
  };

  // Function to calculate uptime percentage from app items
  const calculateUptimePercentage = (
    appItems: AppBatchItem[],
    month: number,
    year: number,
  ): number => {
    if (!appItems || appItems.length === 0) return 0;

    // Filter items for the specific month and year
    const monthItems = appItems.filter((item) => {
      const itemDate = new Date(item.timestamp);
      return itemDate.getMonth() === month && itemDate.getFullYear() === year;
    });

    if (monthItems.length === 0) return 0;

    // Count healthy items (online status true OR health is 'healthy')
    const healthyItems = monthItems.filter(
      (item) => item.onlineStatus === true || item.health === "healthy",
    );

    return parseFloat(
      ((healthyItems.length / monthItems.length) * 100).toFixed(1),
    );
  };

  return (
    <DashboardLayout>
      <div className="container mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-semibold">Admin Panel</h1>
        </div>

        {isLoading ? (
          <div className="flex justify-center items-center h-64">
            <Loader2 className="h-10 w-10 animate-spin text-gray-500" />
          </div>
        ) : (
          <div>
            <div className="flex justify-between border-b mb-6">
              <div className="flex">
                <Button
                  variant={activeTab === "dashboard" ? "default" : "ghost"}
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary mr-2"
                  onClick={() => {
                    setActiveTab("dashboard");
                    // setChosenAppStatus("idle");
                  }}
                >
                  Dashboard
                </Button>
                <Button
                  variant={activeTab === "apps" ? "default" : "ghost"}
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary mr-2"
                  onClick={() => {
                    setActiveTab("apps");
                    // setChosenAppStatus("idle");
                  }}
                >
                  App Submissions
                </Button>
                <Button
                  variant={activeTab === "app_status" ? "default" : "ghost"}
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary mr-2"
                  onClick={() => {
                    setActiveTab("app_status");
                    // setChosenAppStatus("idle");
                  }}
                >
                  App Status
                </Button>
              </div>
              <Button //here
                variant={activeTab != "idle" ? "ghost" : "default"}
                className={`rounded-none border-b-2 border-transparent data-[state=active]:border-primary flex items-center gap-2 ${chosenAppStatus === "" ? "hidden" : "inline-flex"}`}
                onClick={() => {
                  setActiveTab("idle");
                }}
              >
                <Smartphone
                  className={`h-4 w-4 ${activeTab === "idle" ? "text-white" : "text-black"}`}
                />
                <span>{chosenAppStatus}</span>
                <X
                  className={`h-4 w-4 ml-2 cursor-pointer ${activeTab === "idle" ? "text-white hover:bg-gray-600" : "text-black hover:bg-gray-200"} rounded p-0.5`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log("X clicked - closing tab");
                    setChosenAppStatus("");
                    setActiveTab("app_status");
                  }}
                />
              </Button>
            </div>

            {activeTab === "dashboard" && stats && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 mb-8">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-gray-500">
                        Pending Review
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center">
                        <Clock className="h-5 w-5 text-yellow-500 mr-2" />
                        <span className="text-2xl font-bold">
                          {stats.counts.submitted}
                        </span>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-gray-500">
                        Published
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center">
                        <CheckCircle className="h-5 w-5 text-green-500 mr-2" />
                        <span className="text-2xl font-bold">
                          {stats.counts.published}
                        </span>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-gray-500">
                        Rejected
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center">
                        <XCircle className="h-5 w-5 text-red-500 mr-2" />
                        <span className="text-2xl font-bold">
                          {stats.counts.rejected}
                        </span>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-gray-500">
                        Total Apps
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center">
                        <Package className="h-5 w-5 text-blue-500 mr-2" />
                        <span className="text-2xl font-bold">
                          {stats.counts.development +
                            stats.counts.submitted +
                            stats.counts.published +
                            stats.counts.rejected}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle>Recent Submissions</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="divide-y">
                      {stats.recentSubmissions.map((app) => (
                        <div
                          key={app._id}
                          className="py-4 flex justify-between items-center"
                        >
                          <div>
                            <div className="font-medium">{app.name}</div>
                            <div className="text-sm text-gray-500">
                              {app.packageName}
                            </div>
                            <div className="text-xs text-gray-400">
                              Submitted: {formatDate(app.updatedAt)}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => openAppReview(app.packageName)}
                            >
                              Review
                            </Button>
                          </div>
                        </div>
                      ))}

                      {stats.recentSubmissions.length === 0 && (
                        <div className="py-6 text-center text-gray-500">
                          No pending submissions
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </>
            )}

            {activeTab === "apps" && (
              <Card>
                <CardHeader>
                  <CardTitle>App Submissions</CardTitle>
                </CardHeader>
                <CardContent>
                  {submittedApps.length === 0 ? (
                    <div className="py-6 text-center text-gray-500">
                      No pending submissions
                    </div>
                  ) : (
                    <div className="divide-y">
                      {submittedApps.map((app) => (
                        <div
                          key={app._id}
                          className="py-4 flex justify-between items-center"
                        >
                          <div className="flex items-center">
                            <img
                              src={
                                app.logoURL ||
                                "https://placehold.co/100x100?text=App"
                              }
                              alt={app.name}
                              className="w-10 h-10 rounded-md mr-3"
                              onError={(e) => {
                                (e.target as HTMLImageElement).src =
                                  "https://placehold.co/100x100?text=App";
                              }}
                            />
                            <div>
                              <div className="font-medium">{app.name}</div>
                              <div className="text-sm text-gray-500">
                                {app.packageName}
                              </div>
                              <div className="text-xs text-gray-400">
                                Submitted: {formatDate(app.updatedAt)}
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => openAppReview(app.packageName)}
                            >
                              Review
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {activeTab === "app_status" && (
              <div className="space-y-4">
                <div className="flex flex-row gap-[10px]">
                  <Search
                    inputHint="Search app"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  <Select onValueChange={(value) => console.log(value)}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="Submitted" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="production">Submitted</SelectItem>
                    </SelectContent>
                  </Select>
                  <DatePicker
                    className="w-[180px]"
                    initialYear={yearNumber}
                    initialMonth={monthNumberDynamic}
                    setMonthNumberDynamic={setMonthNumberDynamic}
                    setYearNumber={setYearNumber}
                    onPrevMonth={handlePrevMonth}
                    onNextMonth={handleNextMonth}
                  />
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle>
                      <div className="flex-1 flex items-center gap-2.5">
                        <div className="flex-1">App Status</div>
                        <span className="text-sm font-medium text-gray-500"></span>
                        <div className="flex flex-col justify-center items-center">
                          <div className="text-xs text-gray-600">
                            {lastUpdateTime
                              ? lastUpdateTime.toLocaleTimeString()
                              : "Never"}
                          </div>
                        </div>
                        <Button
                          className="w-30"
                          onClick={async () => {
                            await fetchAppStatus();
                            await fetchCollectedAllAppBatchStatus(
                              monthNumberDynamic,
                              yearNumber,
                            );
                          }}
                          disabled={statusLoading}
                        >
                          {statusLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <Clock className="h-4 w-4" />
                              <div>Update</div>
                            </>
                          )}
                        </Button>
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {filteredApps.length === 0 ? (
                      <div className="py-6 text-center text-gray-500">
                        {searchQuery.trim()
                          ? "No apps match your search"
                          : "No pending submissions"}
                      </div>
                    ) : (
                      <div className="divide-y">
                        {filteredApps.map((app) => (
                          <div
                            key={app._id}
                            className="py-4 flex justify-between items-center
                          hover:bg-gray-50 cursor-pointer transition-colors px-4"
                            onClick={() => {
                              setChosenAppStatus(app.name);
                              setActiveTab("idle");
                            }}
                          >
                            <div className="flex items-center">
                              <img
                                src={
                                  app.logoURL ||
                                  "https://placehold.co/100x100?text=App"
                                }
                                alt={app.name}
                                className="w-10 h-10 rounded-md mr-3"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).src =
                                    "https://placehold.co/100x100?text=App";
                                }}
                              />
                              <div>
                                <div className="font-medium">{app.name}</div>
                                <div className="text-sm text-gray-500">
                                  {app.packageName}
                                </div>
                                <div className="text-xs text-gray-400">
                                  Submitted: {formatDate(app.updatedAt)}
                                </div>
                              </div>
                            </div>
                            <UptimeStatus
                              title="Chat"
                              uptimePercentage={calculateUptimePercentage(
                                getAppBatchStatusByPackageName(
                                  collectedAllAppBatchStatus,
                                  app.packageName,
                                ),
                                monthNumberDynamic,
                                yearNumber,
                              )}
                              month={monthNumberDynamic}
                              year={yearNumber}
                              appHealthStatus={
                                submittedAppsStatus.find(
                                  (statusApp) =>
                                    statusApp.packageName === app.packageName,
                                )?.healthStatus ||
                                app.appHealthStatus ||
                                "unknown"
                              }
                              appItems={getAppBatchStatusByPackageName(
                                collectedAllAppBatchStatus,
                                app.packageName,
                              )}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {chosenAppStatus !== "" &&
              activeTab === "idle" &&
              (() => {
                // Find the selected app from submittedApps
                const selectedApp = submittedApps.find(
                  (app) => app.name === chosenAppStatus,
                );

                if (!selectedApp) {
                  return (
                    <Card>
                      <CardContent className="p-6 text-center text-gray-500">
                        App not found: {chosenAppStatus}
                      </CardContent>
                    </Card>
                  );
                }

                // Get real-time health status from submittedAppsStatus array
                const statusApp = submittedAppsStatus.find(
                  (statusApp) =>
                    statusApp.packageName === selectedApp.packageName,
                );

                const healthStatus =
                  statusApp?.healthStatus ||
                  selectedApp.appHealthStatus ||
                  "unknown";
                // console.log(`Selected app health status: ${healthStatus}`);
                // Map health status to Online/Offline
                const getOnlineStatus = (
                  health: string,
                ): "Online" | "Offline" => {
                  switch (health.toLowerCase()) {
                    case "healthy":
                    case "operational":
                    case "up":
                      return "Online";
                    case "unhealthy":
                    case "down":
                    case "error":
                    case "timeout":
                    case "unreachable":
                      return "Offline";
                    default:
                      return "Offline"; // Default to offline for unknown status
                  }
                };

                const isOnline = getOnlineStatus(healthStatus);
                const uptimePercentage =
                  isOnline === "Online"
                    ? 99.984
                    : healthStatus === "timeout"
                      ? 85.5
                      : healthStatus === "unreachable"
                        ? 75.2
                        : 95.123;

                // Create uptime history based on current status
                const uptimeHistory = Array(90)
                  .fill("up")
                  .map((_, i) => {
                    if (isOnline === "Offline") {
                      // Show recent downtime for offline apps
                      if (i > 87) return "down";
                      return Math.random() > 0.05 ? "up" : "down";
                    } else {
                      // Show mostly up with occasional small downtimes
                      return Math.random() > 0.01 ? "up" : "down";
                    }
                  });

                // Transform the app data to match AppStatus interface
                const appStatusData = {
                  id: selectedApp._id || selectedApp.packageName,
                  name: selectedApp.name,
                  logo:
                    selectedApp.logoURL ||
                    "https://placehold.co/48x48/374151/ffffff?text=APP",
                  packageName: selectedApp.packageName,
                  submitted: formatDate(
                    selectedApp.createdAt || selectedApp.updatedAt,
                  ),
                  uptimePercentage,
                  status: healthStatus,
                  uptimeHistory,
                  details: {
                    last24h:
                      isOnline === "Online"
                        ? 100
                        : healthStatus === "timeout"
                          ? 85.5
                          : 98.5,
                    last7d:
                      isOnline === "Online"
                        ? 99.952
                        : healthStatus === "timeout"
                          ? 85.234
                          : 97.234,
                    last30d:
                      isOnline === "Online"
                        ? 99.984
                        : healthStatus === "timeout"
                          ? 85.789
                          : 96.789,
                    last90d: uptimePercentage,
                    events:
                      isOnline === "Offline"
                        ? [
                            {
                              date: new Date().toLocaleDateString(),
                              duration: healthStatus === "timeout" ? 25 : 15,
                              reason:
                                healthStatus === "timeout"
                                  ? "Connection Timeout"
                                  : healthStatus === "unreachable"
                                    ? "Service Unreachable"
                                    : "Health Check Failed",
                              details: `App ${selectedApp.name} ${
                                healthStatus === "timeout"
                                  ? "timed out during health check"
                                  : healthStatus === "unreachable"
                                    ? "is not reachable at the configured endpoint"
                                    : `failed health check with status: ${healthStatus}`
                              }`,
                            },
                          ]
                        : [],
                  },
                };

                return (
                  <AppDetailView
                    app={appStatusData}
                    onRefresh={fetchAppStatus}
                    isRefreshing={statusLoading}
                    appItems={getAppBatchStatusByPackageName(
                      collectedAllAppBatchStatus,
                      selectedApp.packageName,
                    )}
                    lastUpdateTime={lastUpdateTime}
                  />
                );
              })()}

            {/* Admin management tab removed */}
          </div>
        )}

        {/* App Review Dialog */}
        <Dialog open={openReviewDialog} onOpenChange={setOpenReviewDialog}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Review App Submission</DialogTitle>
              <DialogDescription>
                Review the app details before approving or rejecting.
              </DialogDescription>
            </DialogHeader>

            {selectedApp && (
              <div className="space-y-4 py-2">
                <div className="flex items-center space-x-4">
                  <img
                    src={
                      selectedApp.logoURL ||
                      "https://placehold.co/100x100?text=App"
                    }
                    alt={selectedApp.name}
                    className="w-16 h-16 rounded-md"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src =
                        "https://placehold.co/100x100?text=App";
                    }}
                  />
                  <div>
                    <h3 className="font-medium text-lg">{selectedApp.name}</h3>
                    <p className="text-sm text-gray-500">
                      {selectedApp.packageName}
                    </p>
                  </div>
                </div>

                <hr className="border-t border-gray-200" />

                <div>
                  <h4 className="font-medium mb-1">Description</h4>
                  <p className="text-sm">
                    {selectedApp.description || "No description provided"}
                  </p>
                </div>

                {/* Server & Webview URLs */}
                <div className="grid grid-cols-1 gap-2">
                  {selectedApp.publicUrl && (
                    <div className="text-sm">
                      <span className="font-medium">Server URL: </span>
                      <a
                        href={selectedApp.publicUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 underline"
                      >
                        {selectedApp.publicUrl}
                      </a>
                    </div>
                  )}
                  {selectedApp.webviewURL && (
                    <div className="text-sm">
                      <span className="font-medium">Webview URL: </span>
                      <a
                        href={selectedApp.webviewURL}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 underline"
                      >
                        {selectedApp.webviewURL}
                      </a>
                    </div>
                  )}
                </div>

                {/* Tools - Collapsible (default collapsed) */}
                {selectedApp.tools && selectedApp.tools.length > 0 && (
                  <div>
                    <Button
                      variant="ghost"
                      className="px-0 h-auto text-base font-medium flex items-center gap-2"
                      onClick={() => setShowTools((v) => !v)}
                    >
                      {showTools ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      Tools ({selectedApp.tools.length})
                    </Button>
                    {showTools && (
                      <div className="mt-2 space-y-2">
                        {selectedApp.tools.map((tool) => (
                          <div key={tool.id} className="text-sm">
                            <div className="font-medium">{tool.id}</div>
                            <div className="text-gray-600">
                              {tool.description}
                            </div>
                            {tool.activationPhrases &&
                              tool.activationPhrases.length > 0 && (
                                <div className="text-xs text-gray-500">
                                  Activation:{" "}
                                  {tool.activationPhrases.join(", ")}
                                </div>
                              )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Settings - Collapsible (default collapsed) */}
                {selectedApp.settings && selectedApp.settings.length > 0 && (
                  <div>
                    <Button
                      variant="ghost"
                      className="px-0 h-auto text-base font-medium flex items-center gap-2"
                      onClick={() => setShowSettings((v) => !v)}
                    >
                      {showSettings ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      Settings ({selectedApp.settings.length})
                    </Button>
                    {showSettings && (
                      <div className="mt-2 space-y-1 text-sm">
                        {selectedApp.settings.map((s, idx) => (
                          <div
                            key={`${s.key || s.title || s.label || idx}`}
                            className="flex gap-2"
                          >
                            <div className="font-medium">
                              {s.title || s.label || s.key || s.type}
                            </div>
                            <div className="text-gray-600">{s.type}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Permissions */}
                {selectedApp.permissions &&
                  selectedApp.permissions.length > 0 && (
                    <div>
                      <h4 className="font-medium mb-1">Permissions</h4>
                      <div className="flex flex-wrap gap-2">
                        {selectedApp.permissions.map((p, idx) => (
                          <Badge key={`${p.type}-${idx}`} variant="outline">
                            {p.type}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                {/* Hardware Requirements */}
                {selectedApp.hardwareRequirements &&
                  selectedApp.hardwareRequirements.length > 0 && (
                    <div>
                      <h4 className="font-medium mb-1">
                        Hardware Requirements
                      </h4>
                      <div className="space-y-1 text-sm">
                        {selectedApp.hardwareRequirements.map((h, idx) => (
                          <div key={`${h.type}-${idx}`} className="flex gap-2">
                            <div className="font-medium">{h.type}</div>
                            <div className="text-gray-600">{h.level}</div>
                            {h.description && (
                              <div className="text-gray-500">
                                {h.description}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <h4 className="font-medium mb-1">Developer</h4>
                    <p className="text-sm">
                      {selectedApp.organization
                        ? selectedApp.organization.name
                        : selectedApp.developerId || "Unknown"}
                    </p>
                  </div>
                  <div>
                    <h4 className="font-medium mb-1">Submitted</h4>
                    <p className="text-sm">
                      {formatDate(selectedApp.updatedAt)}
                    </p>
                  </div>
                </div>

                {/* Uptime section inside review dialog */}
                <div className="pt-2">
                  <h4 className="font-medium mb-1">Uptime</h4>
                  <div className="mt-2">
                    <UptimeStatus
                      title="Uptime"
                      uptimePercentage={calculateUptimePercentage(
                        getAppBatchStatusByPackageName(
                          collectedAllAppBatchStatus,
                          selectedApp.packageName,
                        ),
                        monthNumberDynamic,
                        yearNumber,
                      )}
                      month={monthNumberDynamic}
                      year={yearNumber}
                      appHealthStatus={
                        submittedAppsStatus.find(
                          (statusApp) =>
                            statusApp.packageName === selectedApp.packageName,
                        )?.healthStatus || "unknown"
                      }
                      appItems={getAppBatchStatusByPackageName(
                        collectedAllAppBatchStatus,
                        selectedApp.packageName,
                      )}
                    />
                  </div>
                </div>
              </div>
            )}

            <hr className="border-t border-gray-200" />

            <div>
              <h4 className="font-medium mb-1">Review Notes</h4>
              <Textarea
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                placeholder="Add review notes here (required for rejection)"
                className="mt-2"
                rows={4}
              />
            </div>

            <DialogFooter className="space-x-3">
              {/* Install/Uninstall for current user */}
              <Button
                variant="secondary"
                onClick={handleInstallToggle}
                disabled={isInstalling || !selectedApp}
              >
                {isInstalling ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : null}
                {isInstalledForUser ? "Uninstall" : "Install"}
              </Button>
              <Button
                variant="outline"
                onClick={() => setOpenReviewDialog(false)}
                disabled={actionLoading}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleReject}
                disabled={actionLoading || !reviewNotes.trim()}
              >
                {actionLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <XCircle className="h-4 w-4 mr-2" />
                )}
                Reject
              </Button>
              <Button onClick={handleApprove} disabled={actionLoading}>
                {actionLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <CheckCircle className="h-4 w-4 mr-2" />
                )}
                Approve
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Admin management dialog removed */}
      </div>
    </DashboardLayout>
  );
};

export default AdminPanel;
