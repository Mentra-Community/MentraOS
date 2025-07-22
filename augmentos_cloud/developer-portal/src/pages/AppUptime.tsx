// pages/AppUptime.tsx
import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from "../components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Wifi, WifiOff, Clock, Activity, AlertCircle } from 'lucide-react';

interface HealthStatus {
  status: string;
  lastCheck?: Date;
  data?: any;
}

const AppUptime: React.FC = () => {
  const { packageName } = useParams<{ packageName: string }>();
  const navigate = useNavigate();
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch health status for the specific app
  useEffect(() => {
    const fetchHealthStatus = async () => {
      if (!packageName) return;

      setIsLoading(true);
      try {
        const healthMonitorPort = process.env.REACT_APP_HEALTH_MONITOR_PORT || '8003';
        const healthMonitorUrl = `http://localhost:${healthMonitorPort}`;
        
        const response = await fetch(`${healthMonitorUrl}/api/app-health`);
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.healthStatuses[packageName]) {
            setHealthStatus(data.healthStatuses[packageName]);
          }
        }
      } catch (error) {
        console.error('Error fetching health status:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchHealthStatus();
    
    // Set up interval to refresh health status every 30 seconds
    const interval = setInterval(fetchHealthStatus, 30000);
    
    return () => clearInterval(interval);
  }, [packageName]);

  const getStatusInfo = () => {
    if (!healthStatus) {
      return {
        status: 'unknown',
        color: 'bg-gray-500',
        icon: <Clock className="h-5 w-5" />,
        text: 'Unknown',
        description: 'Health status information is not available for this app.'
      };
    }

    switch (healthStatus.status) {
      case 'online':
        return {
          status: 'online',
          color: 'bg-green-500',
          icon: <Wifi className="h-5 w-5" />,
          text: 'Online',
          description: 'App is running and responding normally.'
        };
      case 'offline':
        return {
          status: 'offline',
          color: 'bg-red-500',
          icon: <WifiOff className="h-5 w-5" />,
          text: 'Offline',
          description: 'App is not responding or experiencing issues.'
        };
      default:
        return {
          status: 'unknown',
          color: 'bg-gray-500',
          icon: <AlertCircle className="h-5 w-5" />,
          text: 'Unknown',
          description: 'Unable to determine app status at this time.'
        };
    }
  };

  const formatLastCheck = (lastCheck?: Date) => {
    if (!lastCheck) return 'Never';
    
    const date = new Date(lastCheck);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  };

  if (!packageName) {
    return (
      <DashboardLayout>
        <div className="max-w-7xl mx-auto">
          <div className="mb-6">
            <Button 
              variant="ghost" 
              onClick={() => navigate('/admin')}
              className="flex items-center space-x-2"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Back to Admin Panel</span>
            </Button>
          </div>
          
          <Card>
            <CardContent className="flex items-center justify-center py-12">
              <div className="text-center">
                <AlertCircle className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <h2 className="text-xl font-semibold text-gray-900 mb-2">
                  No App Specified
                </h2>
                <p className="text-gray-600">
                  Please select an app from the admin panel to view its uptime status.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  const statusInfo = getStatusInfo();

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <Button 
            variant="ghost" 
            onClick={() => navigate('/admin')}
            className="flex items-center space-x-2 mb-4"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to Admin Panel</span>
          </Button>
          
          <h1 className="text-2xl font-semibold text-gray-900">
            Uptime for {packageName}
          </h1>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {/* Status Card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-gray-500">Current Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center space-x-3">
                <div className={`p-2 rounded-full ${statusInfo.color} text-white`}>
                  {statusInfo.icon}
                </div>
                <div>
                  <div className="text-xl font-bold">{statusInfo.text}</div>
                  <div className="text-sm text-gray-500">{statusInfo.description}</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Last Check Card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-gray-500">Last Health Check</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center space-x-3">
                <div className="p-2 rounded-full bg-blue-500 text-white">
                  <Activity className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-xl font-bold">
                    {formatLastCheck(healthStatus?.lastCheck)}
                  </div>
                  <div className="text-sm text-gray-500">
                    {isLoading ? 'Checking...' : 'Monitoring active'}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Package Info Card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-gray-500">Package Name</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center space-x-3">
                <div className="p-2 rounded-full bg-purple-500 text-white">
                  <Clock className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-lg font-mono break-all">{packageName}</div>
                  <div className="text-sm text-gray-500">Application identifier</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Additional Info Card */}
        <Card>
          <CardHeader>
            <CardTitle>Health Monitoring Information</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <h4 className="font-medium mb-2">About Health Monitoring</h4>
                <p className="text-sm text-gray-600">
                  This page displays real-time health status information for the selected application. 
                  The monitoring system checks app availability and responsiveness at regular intervals.
                </p>
              </div>
              
              {healthStatus?.data && (
                <div>
                  <h4 className="font-medium mb-2">Additional Details</h4>
                  <div className="bg-gray-50 p-3 rounded-md">
                    <pre className="text-sm text-gray-700 overflow-auto">
                      {JSON.stringify(healthStatus.data, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
              
              <div className="pt-4 border-t">
                <div className="flex items-center justify-between text-sm text-gray-500">
                  <span>Auto-refresh every 30 seconds</span>
                  <Badge variant="outline">
                    {isLoading ? 'Updating...' : 'Live'}
                  </Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default AppUptime;