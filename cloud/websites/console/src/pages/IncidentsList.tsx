// pages/IncidentsList.tsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import DashboardLayout from "../components/DashboardLayout";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@mentra/shared";
import { Link, useSearchParams } from "react-router-dom";
import {
  Loader2,
  Bug,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  CheckCircle,
  Clock,
  AlertTriangle,
} from "lucide-react";
import api, { Incident } from "../services/api.service";

const IncidentsList: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const limitParam = Number(searchParams.get("limit"));
  const offsetParam = Number(searchParams.get("offset"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : 25;
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? Math.floor(offsetParam) : 0;
  const q = searchParams.get("q") || "";
  const submissionMode = (searchParams.get("submissionMode") || "") as "" | Incident["submissionMode"];
  const triggerArea = searchParams.get("triggerArea") || "";
  const triggerReason = searchParams.get("triggerReason") || "";

  const [searchInput, setSearchInput] = useState(q);
  const [triggerAreaInput, setTriggerAreaInput] = useState(triggerArea);
  const [triggerReasonInput, setTriggerReasonInput] = useState(triggerReason);

  const [isLoading, setIsLoading] = useState(true);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [serverMeta, setServerMeta] = useState({ total: 0, hasMore: false });
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const requestIdRef = useRef(0);

  // Keep text inputs in sync when URL changes (browser back/forward, shared links).
  useEffect(() => {
    setSearchInput(q);
    setTriggerAreaInput(triggerArea);
    setTriggerReasonInput(triggerReason);
  }, [q, triggerArea, triggerReason]);

  // Debounce text filters into the URL and reset to page 1.
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setSearchParams(
        (prev) => {
          const currentQ = prev.get("q") || "";
          const currentArea = prev.get("triggerArea") || "";
          const currentReason = prev.get("triggerReason") || "";
          if (
            searchInput === currentQ &&
            triggerAreaInput === currentArea &&
            triggerReasonInput === currentReason
          ) {
            return prev;
          }
          const next = new URLSearchParams(prev);
          if (searchInput) {
            next.set("q", searchInput);
          } else {
            next.delete("q");
          }
          if (triggerAreaInput) {
            next.set("triggerArea", triggerAreaInput);
          } else {
            next.delete("triggerArea");
          }
          if (triggerReasonInput) {
            next.set("triggerReason", triggerReasonInput);
          } else {
            next.delete("triggerReason");
          }
          next.delete("offset");
          return next;
        },
        { replace: false },
      );
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [searchInput, triggerAreaInput, triggerReasonInput, setSearchParams]);

  const fetchIncidents = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.incidents.list(limit, offset, {
        q: q.trim() || undefined,
        submissionMode: submissionMode || undefined,
        triggerArea: triggerArea.trim() || undefined,
        triggerReason: triggerReason.trim() || undefined,
      });
      if (requestId !== requestIdRef.current) {
        return;
      }
      setIncidents(response.data);
      setServerMeta({
        total: response.pagination.total,
        hasMore: response.pagination.hasMore,
      });
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      console.error("Failed to fetch incidents:", err);
      const axiosLike = err as { response?: { data?: { message?: string } } };
      setError(axiosLike.response?.data?.message || "Failed to load incidents");
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [limit, offset, q, submissionMode, triggerArea, triggerReason]);

  useEffect(() => {
    void fetchIncidents();
  }, [fetchIncidents, refreshTick]);

  const setSubmissionModeInUrl = (value: "" | Incident["submissionMode"]) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) {
          next.set("submissionMode", value);
        } else {
          next.delete("submissionMode");
        }
        next.delete("offset");
        return next;
      },
      { replace: false },
    );
  };

  const goToNextPage = () => {
    if (!serverMeta.hasMore) {
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("offset", String(offset + limit));
        return next;
      },
      { replace: false },
    );
  };

  const goToPrevPage = () => {
    if (offset <= 0) {
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const nextOffset = Math.max(0, offset - limit);
        if (nextOffset === 0) {
          next.delete("offset");
        } else {
          next.set("offset", String(nextOffset));
        }
        return next;
      },
      { replace: false },
    );
  };

  const getStatusBadge = (status: Incident["status"]) => {
    switch (status) {
      case "complete":
        return (
          <Badge className="bg-green-100 text-green-800 hover:bg-green-200">
            <CheckCircle className="w-3 h-3 mr-1" />
            Complete
          </Badge>
        );
      case "partial":
        return (
          <Badge className="bg-yellow-100 text-yellow-800 hover:bg-yellow-200">
            <AlertTriangle className="w-3 h-3 mr-1" />
            Partial
          </Badge>
        );
      case "failed":
        return (
          <Badge className="bg-red-100 text-red-800 hover:bg-red-200">
            <AlertCircle className="w-3 h-3 mr-1" />
            Failed
          </Badge>
        );
      case "processing":
      default:
        return (
          <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-200">
            <Clock className="w-3 h-3 mr-1" />
            Processing
          </Badge>
        );
    }
  };

  const getSubmissionBadge = (mode?: Incident["submissionMode"]) => {
    if (mode === "AUTOMATIC") {
      return <Badge className="bg-slate-100 text-slate-800 hover:bg-slate-200">Automatic</Badge>;
    }
    if (mode === "USER_INITIATED") {
      return <Badge className="bg-indigo-100 text-indigo-800 hover:bg-indigo-200">User Initiated</Badge>;
    }
    return null;
  };

  const formatAreaLabel = (value?: string) =>
    value
      ? value
          .split("_")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ")
      : null;

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Bug className="h-6 w-6 text-red-500" />
            <h1 className="text-2xl font-bold">Bug Report Incidents</h1>
          </div>
          <Button
            variant="outline"
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={isLoading}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Refresh
          </Button>
        </div>

        <Card>
          <CardContent className="py-4">
            <div className="grid gap-3 md:grid-cols-4">
              <input
                className="h-10 rounded-md border border-gray-300 px-3 text-sm"
                placeholder="Search user, applet, reason, summary..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              <select
                className="h-10 rounded-md border border-gray-300 px-3 text-sm"
                value={submissionMode}
                onChange={(e) =>
                  setSubmissionModeInUrl(e.target.value as "" | Incident["submissionMode"])
                }>
                <option value="">All submission modes</option>
                <option value="USER_INITIATED">User initiated</option>
                <option value="AUTOMATIC">Automatic</option>
              </select>
              <input
                className="h-10 rounded-md border border-gray-300 px-3 text-sm"
                placeholder="Filter trigger area"
                value={triggerAreaInput}
                onChange={(e) => setTriggerAreaInput(e.target.value)}
              />
              <input
                className="h-10 rounded-md border border-gray-300 px-3 text-sm"
                placeholder="Filter trigger reason"
                value={triggerReasonInput}
                onChange={(e) => setTriggerReasonInput(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Error state */}
        {error && (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="py-4">
              <div className="flex items-center gap-2 text-red-800">
                <AlertCircle className="h-5 w-5" />
                <p>{error}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        )}

        {/* Incidents list */}
        {!isLoading && !error && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Recent Incidents ({serverMeta.total} total)</CardTitle>
            </CardHeader>
            <CardContent>
              {incidents.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Bug className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                  <p>No incidents found</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {incidents.map((incident) => (
                    <div
                      key={incident.incidentId}
                      className="flex items-center border rounded-lg hover:bg-gray-50 transition-colors">
                      <Link
                        to={`/admin/incidents/${incident.incidentId}`}
                        className="flex items-center justify-between flex-1 p-4 min-w-0 text-inherit no-underline">
                        <div className="flex items-center gap-4 flex-1 min-w-0">
                          <div className="flex flex-col min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm text-gray-500">
                                {incident.incidentId.slice(0, 8)}...
                              </span>
                              <span className="text-sm text-gray-400">·</span>
                              <span className="text-sm text-gray-600 truncate">{incident.userId}</span>
                            </div>
                            {incident.summary && (
                              <span className="text-sm font-medium text-gray-800 truncate mt-1">
                                {incident.summary}
                              </span>
                            )}
                            <div className="flex flex-wrap items-center gap-2 mt-2">
                              {getSubmissionBadge(incident.submissionMode)}
                              {incident.triggerArea && (
                                <Badge className="bg-gray-100 text-gray-700 hover:bg-gray-200">
                                  {formatAreaLabel(incident.triggerArea)}
                                </Badge>
                              )}
                              {incident.sourceAppletName && (
                                <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-200">
                                  {incident.sourceAppletName}
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 flex-shrink-0">
                          <span className="text-sm text-gray-500">{formatDate(incident.createdAt)}</span>
                          {getStatusBadge(incident.status)}
                        </div>
                      </Link>

                      {incident.linearIssueUrl && (
                        <a
                          href={incident.linearIssueUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 text-blue-500 hover:text-blue-700 shrink-0"
                          aria-label="Open Linear issue">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                      <ChevronRight className="h-4 w-4 text-gray-400 shrink-0 pr-4" aria-hidden />
                    </div>
                  ))}
                </div>
              )}

              {/* Pagination */}
              {incidents.length > 0 && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t">
                  <Button variant="outline" size="sm" onClick={goToPrevPage} disabled={offset === 0}>
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  <span className="text-sm text-gray-500">
                    Showing {offset + 1} - {Math.min(offset + incidents.length, serverMeta.total)} of{" "}
                    {serverMeta.total}
                  </span>
                  <Button variant="outline" size="sm" onClick={goToNextPage} disabled={!serverMeta.hasMore}>
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
};

export default IncidentsList;
