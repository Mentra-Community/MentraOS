// pages/IncidentsList.tsx
import React, { useState, useEffect } from "react";
import DashboardLayout from "../components/DashboardLayout";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@mentra/shared";
import { useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [pagination, setPagination] = useState({
    total: 0,
    limit: 25,
    offset: 0,
    hasMore: false,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchIncidents();
  }, [pagination.offset, pagination.limit]);

  const fetchIncidents = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.incidents.list(
        pagination.limit,
        pagination.offset
      );
      setIncidents(response.data);
      setPagination((prev) => ({
        ...prev,
        ...response.pagination,
      }));
    } catch (err: any) {
      console.error("Failed to fetch incidents:", err);
      setError(err.response?.data?.message || "Failed to load incidents");
    } finally {
      setIsLoading(false);
    }
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

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const goToNextPage = () => {
    if (pagination.hasMore) {
      setPagination((prev) => ({
        ...prev,
        offset: prev.offset + prev.limit,
      }));
    }
  };

  const goToPrevPage = () => {
    if (pagination.offset > 0) {
      setPagination((prev) => ({
        ...prev,
        offset: Math.max(0, prev.offset - prev.limit),
      }));
    }
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
          <Button variant="outline" onClick={fetchIncidents} disabled={isLoading}>
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            Refresh
          </Button>
        </div>

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
              <CardTitle className="text-lg">
                Recent Incidents ({pagination.total} total)
              </CardTitle>
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
                      className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50 cursor-pointer transition-colors"
                      onClick={() =>
                        navigate(`/admin/incidents/${incident.incidentId}`)
                      }
                    >
                      <div className="flex items-center gap-4 flex-1 min-w-0">
                        <div className="flex flex-col min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm text-gray-500">
                              {incident.incidentId.slice(0, 8)}...
                            </span>
                            <span className="text-sm text-gray-400">·</span>
                            <span className="text-sm text-gray-600 truncate">
                              {incident.userId}
                            </span>
                          </div>
                          {incident.summary && (
                            <span className="text-sm font-medium text-gray-800 truncate mt-1">
                              {incident.summary}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-4 flex-shrink-0">
                        <span className="text-sm text-gray-500">
                          {formatDate(incident.createdAt)}
                        </span>
                        {getStatusBadge(incident.status)}
                        {incident.linearIssueUrl && (
                          <a
                            href={incident.linearIssueUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-blue-500 hover:text-blue-700"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        )}
                        <ChevronRight className="h-4 w-4 text-gray-400" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Pagination */}
              {incidents.length > 0 && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={goToPrevPage}
                    disabled={pagination.offset === 0}
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  <span className="text-sm text-gray-500">
                    Showing {pagination.offset + 1} -{" "}
                    {Math.min(
                      pagination.offset + incidents.length,
                      pagination.total
                    )}{" "}
                    of {pagination.total}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={goToNextPage}
                    disabled={!pagination.hasMore}
                  >
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
