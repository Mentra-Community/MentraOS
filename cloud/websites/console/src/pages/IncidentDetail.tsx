// pages/IncidentDetail.tsx
import React, { useState, useEffect } from "react";
import DashboardLayout from "../components/DashboardLayout";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@mentra/shared";
import { useParams, useNavigate } from "react-router-dom";
import {
  Loader2,
  Bug,
  ExternalLink,
  ArrowLeft,
  AlertCircle,
  CheckCircle,
  Clock,
  AlertTriangle,
  Smartphone,
  Cloud,
  Glasses,
  Cpu,
  Activity,
  Copy,
  Check,
  Image as ImageIcon,
  X,
} from "lucide-react";
import api, { Incident, IncidentLogs, IncidentLogEntry } from "../services/api.service";

const IncidentDetail: React.FC = () => {
  const { incidentId } = useParams<{ incidentId: string }>();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [incident, setIncident] = useState<Incident | null>(null);
  const [logs, setLogs] = useState<IncidentLogs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    "feedback" | "phone" | "cloud" | "glasses" | "glasses_firmware" | "telemetry" | "attachments"
  >("feedback");
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedApp, setSelectedApp] = useState<string | null>(null);

  useEffect(() => {
    if (incidentId) {
      fetchIncidentData();
    }
  }, [incidentId]);

  const fetchIncidentData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [incidentData, logsData] = await Promise.all([
        api.admin.incidents.get(incidentId!),
        api.admin.incidents.getLogs(incidentId!),
      ]);
      setIncident(incidentData);
      setLogs(logsData);
    } catch (err: any) {
      console.error("Failed to fetch incident:", err);
      setError(err.response?.data?.message || "Failed to load incident");
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusBadge = (status: Incident["status"]) => {
    switch (status) {
      case "complete":
        return (
          <Badge className="bg-green-100 text-green-800">
            <CheckCircle className="w-3 h-3 mr-1" />
            Complete
          </Badge>
        );
      case "partial":
        return (
          <Badge className="bg-yellow-100 text-yellow-800">
            <AlertTriangle className="w-3 h-3 mr-1" />
            Partial
          </Badge>
        );
      case "failed":
        return (
          <Badge className="bg-red-100 text-red-800">
            <AlertCircle className="w-3 h-3 mr-1" />
            Failed
          </Badge>
        );
      case "processing":
      default:
        return (
          <Badge className="bg-blue-100 text-blue-800">
            <Clock className="w-3 h-3 mr-1" />
            Processing
          </Badge>
        );
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const formatLogTimestamp = (timestamp: number | string) => {
    const date = new Date(typeof timestamp === "number" ? timestamp : timestamp);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    });
  };

  const getLevelColor = (level: string) => {
    switch (level.toLowerCase()) {
      case "error":
        return "text-red-600 bg-red-50";
      case "warn":
      case "warning":
        return "text-yellow-600 bg-yellow-50";
      case "debug":
        return "text-gray-500 bg-gray-50";
      default:
        return "text-blue-600 bg-blue-50";
    }
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderLogEntries = (entries: IncidentLogEntry[], emptyMessage: string) => {
    if (!entries || entries.length === 0) {
      return (
        <div className="text-center py-8 text-gray-500">
          <p>{emptyMessage}</p>
        </div>
      );
    }

    return (
      <div className="space-y-1 font-mono text-sm max-h-[600px] overflow-y-auto">
        {entries.map((entry, idx) => (
          <div key={idx} className={`flex gap-2 p-2 rounded ${getLevelColor(entry.level)}`}>
            <span className="text-gray-400 whitespace-nowrap">{formatLogTimestamp(entry.timestamp)}</span>
            <span className="font-semibold uppercase w-12">{entry.level.slice(0, 5)}</span>
            {entry.source && <span className="text-gray-500">[{entry.source}]</span>}
            <span className="flex-1 break-all">{entry.message}</span>
          </div>
        ))}
      </div>
    );
  };

  // Get app package names from telemetry logs
  const appPackages = logs?.appTelemetryLogs ? Object.keys(logs.appTelemetryLogs) : [];
  const totalTelemetryLogs = appPackages.reduce((sum, pkg) => sum + (logs?.appTelemetryLogs?.[pkg]?.length || 0), 0);

  const tabs = [
    { id: "feedback", label: "Feedback", icon: Bug, count: null },
    { id: "phone", label: "Phone Logs", icon: Smartphone, count: logs?.phoneLogs?.length || 0 },
    { id: "cloud", label: "Cloud Logs", icon: Cloud, count: logs?.cloudLogs?.length || 0 },
    { id: "glasses", label: "Glasses Logs (ASG Client)", icon: Glasses, count: logs?.glassesLogs?.length || 0 },
    {
      id: "glasses_firmware",
      label: "Glasses firmware (BES)",
      icon: Cpu,
      count: logs?.glassesFirmwareLogs?.length || 0,
    },
    { id: "telemetry", label: "App Telemetry", icon: Activity, count: totalTelemetryLogs },
    { id: "attachments", label: "Screenshots", icon: ImageIcon, count: logs?.attachments?.length || 0 },
  ] as const;

  const getAttachmentUrl = (storedAs: string) => {
    // Extract just the filename from the full path (e.g., "incidents/{id}/attachments/{filename}")
    const filename = storedAs.split("/").pop();
    return `/api/console/admin/incidents/${incidentId}/attachments/${filename}`;
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      </DashboardLayout>
    );
  }

  if (error || !incident) {
    return (
      <DashboardLayout>
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-red-800">
              <AlertCircle className="h-5 w-5" />
              <p>{error || "Incident not found"}</p>
            </div>
            <Button variant="outline" className="mt-4" onClick={() => navigate("/admin/incidents")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Incidents
            </Button>
          </CardContent>
        </Card>
      </DashboardLayout>
    );
  }

  const feedback = (logs?.feedback as Record<string, any>) || {};

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" onClick={() => navigate("/admin/incidents")}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
            <div>
              <div className="flex items-center gap-3">
                <Bug className="h-5 w-5 text-red-500" />
                <h1 className="text-xl font-bold">{incident.summary || `Incident ${incidentId?.slice(0, 8)}...`}</h1>
                {getStatusBadge(incident.status)}
              </div>
              <p className="text-sm text-gray-500 mt-1">
                <span className="font-mono">{incidentId?.slice(0, 8)}...</span>
                {" · "}Reported by {incident.userId} on {formatDate(incident.createdAt)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => copyToClipboard(incidentId!)}>
              {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
              {copied ? "Copied!" : "Copy ID"}
            </Button>
            {incident.linearIssueUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={incident.linearIssueUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-1" />
                  View in Linear
                </a>
              </Button>
            )}
          </div>
        </div>

        {/* Error message if present */}
        {incident.errorMessage && (
          <Card className="border-yellow-200 bg-yellow-50">
            <CardContent className="py-3">
              <div className="flex items-center gap-2 text-yellow-800">
                <AlertTriangle className="h-5 w-5" />
                <p className="text-sm">Processing errors: {incident.errorMessage}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tabs */}
        <div className="border-b">
          <div className="flex gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? "border-blue-500 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}>
                <tab.icon className="h-4 w-4" />
                {tab.label}
                {tab.count !== null && tab.count > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {tab.count}
                  </Badge>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <Card>
          <CardContent className="pt-6">
            {activeTab === "feedback" && (
              <div className="space-y-6">
                {/* Bug report details */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-gray-500">Type</label>
                    <p className="mt-1 capitalize">{feedback.type || "bug"}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">Severity</label>
                    <p className="mt-1">{feedback.severityRating || "N/A"}/5</p>
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium text-gray-500">Expected Behavior</label>
                  <p className="mt-1 p-3 bg-gray-50 rounded-lg">{feedback.expectedBehavior || "Not specified"}</p>
                </div>

                <div>
                  <label className="text-sm font-medium text-gray-500">Actual Behavior</label>
                  <p className="mt-1 p-3 bg-gray-50 rounded-lg">{feedback.actualBehavior || "Not specified"}</p>
                </div>

                {/* System info */}
                {feedback.systemInfo && (
                  <div>
                    <label className="text-sm font-medium text-gray-500 mb-2 block">System Info</label>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3 bg-gray-50 rounded-lg">
                      <div>
                        <span className="text-xs text-gray-500">App Version</span>
                        <p className="text-sm">{feedback.systemInfo.appVersion || "Unknown"}</p>
                      </div>
                      <div>
                        <span className="text-xs text-gray-500">Device</span>
                        <p className="text-sm">{feedback.systemInfo.deviceName || "Unknown"}</p>
                      </div>
                      <div>
                        <span className="text-xs text-gray-500">OS</span>
                        <p className="text-sm">{feedback.systemInfo.osVersion || "Unknown"}</p>
                      </div>
                      <div>
                        <span className="text-xs text-gray-500">Platform</span>
                        <p className="text-sm">{feedback.systemInfo.platform || "Unknown"}</p>
                      </div>
                      <div>
                        <span className="text-xs text-gray-500">Glasses Connected</span>
                        <p className="text-sm">{feedback.systemInfo.glassesConnected ? "Yes" : "No"}</p>
                      </div>
                      <div>
                        <span className="text-xs text-gray-500">Network</span>
                        <p className="text-sm">{feedback.systemInfo.networkType || "Unknown"}</p>
                      </div>
                      <div>
                        <span className="text-xs text-gray-500">Build</span>
                        <p className="text-sm font-mono text-xs">
                          {feedback.systemInfo.buildCommit?.slice(0, 8) || "Unknown"}
                        </p>
                      </div>
                      <div>
                        <span className="text-xs text-gray-500">Branch</span>
                        <p className="text-sm">{feedback.systemInfo.buildBranch || "Unknown"}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Phone state */}
                {logs?.phoneState && Object.keys(logs.phoneState).length > 0 && (
                  <div>
                    <label className="text-sm font-medium text-gray-500 mb-2 block">
                      Phone State at Time of Report
                    </label>
                    <pre className="p-3 bg-gray-50 rounded-lg overflow-auto max-h-48 text-xs">
                      {JSON.stringify(logs.phoneState, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {activeTab === "phone" && renderLogEntries(logs?.phoneLogs || [], "No phone logs collected")}
            {activeTab === "cloud" && renderLogEntries(logs?.cloudLogs || [], "No cloud logs collected")}
            {activeTab === "glasses" && renderLogEntries(logs?.glassesLogs || [], "No glasses logs collected")}
            {activeTab === "glasses_firmware" &&
              renderLogEntries(logs?.glassesFirmwareLogs || [], "No glasses firmware (BES) logs collected")}
            {activeTab === "telemetry" && (
              <div>
                {appPackages.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <Activity className="h-12 w-12 mx-auto mb-2 text-gray-400" />
                    <p>No app telemetry logs collected</p>
                  </div>
                ) : appPackages.length === 1 ? (
                  // Single app - show directly without sub-tabs
                  <div>
                    <p className="text-xs text-gray-500 mb-2 font-mono">{appPackages[0]}</p>
                    {renderLogEntries(logs?.appTelemetryLogs?.[appPackages[0]] || [], "No logs from this app")}
                  </div>
                ) : (
                  // Multiple apps - show sub-tabs
                  <div>
                    {/* App sub-tabs */}
                    <div className="flex gap-2 mb-4 flex-wrap">
                      {appPackages.map((pkg) => (
                        <button
                          key={pkg}
                          onClick={() => setSelectedApp(selectedApp === pkg ? null : pkg)}
                          className={`px-3 py-1.5 text-sm rounded-full transition-colors ${
                            selectedApp === pkg
                              ? "bg-blue-100 text-blue-700 border border-blue-300"
                              : "bg-gray-100 text-gray-600 hover:bg-gray-200 border border-transparent"
                          }`}>
                          {pkg.split(".").pop()}
                          <span className="ml-1.5 text-xs opacity-70">
                            ({logs?.appTelemetryLogs?.[pkg]?.length || 0})
                          </span>
                        </button>
                      ))}
                    </div>

                    {/* Show selected app's logs or prompt to select */}
                    {selectedApp ? (
                      <div>
                        <p className="text-xs text-gray-500 mb-2 font-mono">{selectedApp}</p>
                        {renderLogEntries(logs?.appTelemetryLogs?.[selectedApp] || [], "No logs from this app")}
                      </div>
                    ) : (
                      <div className="text-center py-8 text-gray-500">
                        <p>Select an app above to view its logs</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === "attachments" && (
              <div>
                {!logs?.attachments || logs.attachments.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <ImageIcon className="h-12 w-12 mx-auto mb-2 text-gray-400" />
                    <p>No screenshots attached to this incident</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {logs.attachments.map((attachment, idx) => (
                      <div
                        key={attachment.storedAs}
                        className="relative group cursor-pointer rounded-lg overflow-hidden border border-gray-200 hover:border-blue-500 transition-colors"
                        onClick={() => setSelectedImage(getAttachmentUrl(attachment.storedAs))}>
                        <img
                          src={getAttachmentUrl(attachment.storedAs)}
                          alt={attachment.filename}
                          className="w-full h-40 object-cover"
                        />
                        <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs p-2">
                          <p className="truncate">{attachment.filename}</p>
                          <p className="text-gray-300">{(attachment.size / 1024).toFixed(1)} KB</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Image Lightbox */}
        {selectedImage && (
          <div
            className="fixed inset-0 bg-black/80 flex items-center justify-center z-50"
            onClick={() => setSelectedImage(null)}>
            <button
              className="absolute top-4 right-4 text-white hover:text-gray-300"
              onClick={() => setSelectedImage(null)}>
              <X className="h-8 w-8" />
            </button>
            <img
              src={selectedImage}
              alt="Screenshot"
              className="max-w-[90vw] max-h-[90vh] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default IncidentDetail;
