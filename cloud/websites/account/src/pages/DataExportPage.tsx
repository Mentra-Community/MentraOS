import React, { useState, useEffect } from "react";
import { useAuth } from "@mentra/shared";
import AccountLayout from "../components/AccountLayout";
import { toast } from "sonner";
// import api from '../services/api.service';

// Status for the export request
type ExportStatus =
  | "idle"
  | "requested"
  | "processing"
  | "completed"
  | "failed";

// Interface for export request
interface ExportRequest {
  id: string;
  status: ExportStatus;
  createdAt: string;
  format: "json" | "csv";
  downloadUrl?: string;
}

const DataExportPage: React.FC = () => {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [exportFormat, setExportFormat] = useState<"json" | "csv">("json");
  const [currentExport, setCurrentExport] = useState<ExportRequest | null>(
    null,
  );
  const [refreshInterval, setRefreshInterval] = useState<number | null>(null);

  // Simulated function to check export status
  const checkExportStatus = async (_exportId: string) => {
    try {
      // Simulate API call to check export status
      // In a real implementation, we would use:
      // const exportStatus = await api.export.getStatus(exportId);

      // For the demo, we'll simulate a processing state that eventually completes
      const now = new Date();
      const createdTime = currentExport?.createdAt
        ? new Date(currentExport.createdAt)
        : now;
      const elapsedSeconds = Math.floor(
        (now.getTime() - createdTime.getTime()) / 1000,
      );

      let newStatus: ExportStatus = "processing";

      // After 5 seconds, mark as completed
      if (elapsedSeconds > 5) {
        newStatus = "completed";
        // Clear the interval when completed
        if (refreshInterval) {
          clearInterval(refreshInterval);
          setRefreshInterval(null);
        }
      }

      const updatedExport: ExportRequest = {
        ...currentExport!,
        status: newStatus,
        downloadUrl: newStatus === "completed" ? "data-export.json" : undefined,
      };

      setCurrentExport(updatedExport);
    } catch (error) {
      console.error("Error checking export status:", error);
      toast.error("Failed to check export status");

      // Clear the interval on error
      if (refreshInterval) {
        clearInterval(refreshInterval);
        setRefreshInterval(null);
      }
    }
  };

  // Clean up interval on unmount
  useEffect(() => {
    return () => {
      if (refreshInterval) {
        clearInterval(refreshInterval);
      }
    };
  }, [refreshInterval]);

  // Handle request for data export
  const handleRequestExport = async () => {
    setIsLoading(true);

    try {
      // Simulate API call to request export
      // In a real implementation, we would use:
      // const exportRequest = await api.export.requestExport(exportFormat);

      // For the demo, we'll create a mock export request
      const mockExportId =
        "export_" + Math.random().toString(36).substring(2, 11);
      const mockExport: ExportRequest = {
        id: mockExportId,
        status: "processing",
        createdAt: new Date().toISOString(),
        format: exportFormat,
      };

      setCurrentExport(mockExport);
      toast.success("Export request submitted successfully");

      // Set up interval to check status
      const intervalId = window.setInterval(() => {
        checkExportStatus(mockExportId);
      }, 2000);

      setRefreshInterval(intervalId);
    } catch (error) {
      console.error("Error requesting export:", error);
      toast.error("Failed to request data export");
    } finally {
      setIsLoading(false);
    }
  };

  // Handle download of exported data
  const handleDownload = () => {
    // In a real implementation, we would download the file using the downloadUrl
    // window.location.href = currentExport?.downloadUrl || '';

    // For the demo, we'll just show a success message
    toast.success("Your data has been downloaded");
  };

  // Render export status
  const renderExportStatus = () => {
    if (!currentExport) return null;

    return (
      <div className="mt-8 border rounded-md p-4">
        <h3 className="font-medium text-lg mb-2">Export Status</h3>

        <div className="space-y-2">
          <div>
            <span className="font-medium">Request ID:</span> {currentExport.id}
          </div>
          <div>
            <span className="font-medium">Created:</span>{" "}
            {new Date(currentExport.createdAt).toLocaleString()}
          </div>
          <div>
            <span className="font-medium">Format:</span>{" "}
            {currentExport.format.toUpperCase()}
          </div>
          <div>
            <span className="font-medium">Status:</span>{" "}
            {currentExport.status === "processing" ? (
              <span className="inline-flex items-center">
                Processing
                <svg
                  className="animate-spin ml-2 h-4 w-4 text-blue-500"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              </span>
            ) : currentExport.status === "completed" ? (
              <span className="text-green-600">Completed</span>
            ) : (
              currentExport.status
            )}
          </div>
        </div>

        {currentExport.status === "completed" && (
          <div className="mt-4">
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              Download Data
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <AccountLayout>
      <div>
        <h1 className="text-2xl font-bold mb-4">Export Your Data</h1>
        <p className="mb-6">
          You can export all your Mentra data for your records. The export will
          include your profile information, preferences, and usage data.
        </p>

        <div className="bg-blue-50 border-l-4 border-blue-400 p-4 mb-6">
          <div className="flex">
            <div className="ml-3">
              <p className="text-sm text-blue-700">
                Your data will be exported as a single file that you can
                download. The process may take a few minutes to complete.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6">
          <h2 className="text-lg font-medium mb-4">Export Settings</h2>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Export Format
            </label>
            <div className="flex space-x-4">
              <label className="inline-flex items-center">
                <input
                  type="radio"
                  className="form-radio h-4 w-4 text-blue-600"
                  checked={exportFormat === "json"}
                  onChange={() => setExportFormat("json")}
                />
                <span className="ml-2">JSON</span>
              </label>
              <label className="inline-flex items-center">
                <input
                  type="radio"
                  className="form-radio h-4 w-4 text-blue-600"
                  checked={exportFormat === "csv"}
                  onChange={() => setExportFormat("csv")}
                />
                <span className="ml-2">CSV</span>
              </label>
            </div>
          </div>

          <div className="mt-6">
            <button
              type="button"
              onClick={handleRequestExport}
              disabled={isLoading || currentExport?.status === "processing"}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {isLoading ? "Processing..." : "Export My Data"}
            </button>
          </div>
        </div>

        {renderExportStatus()}
      </div>
    </AccountLayout>
  );
};

export default DataExportPage;
