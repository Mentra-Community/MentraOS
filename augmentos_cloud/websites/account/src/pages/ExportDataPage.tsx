import React, { useState } from 'react';
import DashboardLayout from '../components/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Label } from "../components/ui/label";

const ExportDataPage: React.FC = () => {
  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('json');
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  
  const handleExportRequest = async () => {
    setExportStatus('loading');
    try {
      // This is a placeholder - in a real implementation, you would call your API
      // await api.export.requestExport(exportFormat);
      console.log("Export requested in format:", exportFormat);
      
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      setExportStatus('success');
      setTimeout(() => setExportStatus('idle'), 5000);
    } catch (error) {
      console.error("Failed to request data export:", error);
      setExportStatus('error');
      setTimeout(() => setExportStatus('idle'), 5000);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">Export Your Data</h1>
        </div>

        <div className="grid grid-cols-1 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Data Export</CardTitle>
              <CardDescription>
                Request a download of all your data from AugmentOS
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-medium mb-2">What data will be included?</h3>
                  <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                    <li>Your profile information</li>
                    <li>App usage history</li>
                    <li>Account activity</li>
                    <li>Device settings and preferences</li>
                  </ul>
                </div>

                <div>
                  <h3 className="text-sm font-medium mb-2">Select export format</h3>
                  <RadioGroup 
                    value={exportFormat} 
                    onValueChange={(value) => setExportFormat(value as 'json' | 'csv')}
                    className="space-y-2"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="json" id="json" />
                      <Label htmlFor="json" className="font-normal">
                        JSON (recommended for developers)
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="csv" id="csv" />
                      <Label htmlFor="csv" className="font-normal">
                        CSV (recommended for spreadsheet software)
                      </Label>
                    </div>
                  </RadioGroup>
                </div>

                <div className="border-t pt-4">
                  <div className="text-sm text-gray-600 mb-4">
                    <p>
                      Once you request an export, we'll process your data and send you an email with a download link.
                      This process may take up to 24 hours to complete.
                    </p>
                  </div>

                  <div className="flex items-center">
                    <Button
                      onClick={handleExportRequest}
                      disabled={exportStatus === 'loading'}
                    >
                      {exportStatus === 'loading' ? "Processing..." : "Request Data Export"}
                    </Button>
                    
                    {exportStatus === 'success' && (
                      <p className="ml-4 text-sm text-green-600">
                        Export request received! You'll receive an email when your data is ready.
                      </p>
                    )}
                    
                    {exportStatus === 'error' && (
                      <p className="ml-4 text-sm text-red-600">
                        Something went wrong. Please try again later.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Previous Exports</CardTitle>
              <CardDescription>
                Download or check status of your recent data export requests
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-center py-6 text-gray-500">
                <p>You have no previous export requests.</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default ExportDataPage;