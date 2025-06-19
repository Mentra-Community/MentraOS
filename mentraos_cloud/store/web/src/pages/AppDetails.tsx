import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Download, X, ExternalLink, Calendar, Clock, Info, Star, Package, Building, Globe, Mail, FileText } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import api from '../api';
import { AppI } from '../types';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import Header from '../components/Header';
import AppPermissions from '../components/AppPermissions';

const AppDetails: React.FC = () => {
  const { packageName } = useParams<{ packageName: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated } = useAuth();

  const [app, setApp] = useState<AppI | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installingApp, setInstallingApp] = useState<boolean>(false);

  // Fetch app details on component mount
  useEffect(() => {
    if (packageName) {
      fetchAppDetails(packageName);
    }
  }, [packageName, isAuthenticated]);

  /**
   * Navigates to the app store filtered by the given organization ID
   * @param orgId Organization ID to filter by
   */
  const navigateToOrgApps = (orgId: string) => {
    navigate(`/?orgId=${orgId}`);
  };

  // Fetch app details and install status
  const fetchAppDetails = async (pkgName: string) => {
    try {
      setIsLoading(true);
      setError(null);

      // Get app details
      const appDetails = await api.app.getAppByPackageName(pkgName);
      console.log('Raw app details from API:', appDetails);

      if (!appDetails) {
        setError('App not found');
        return;
      }

      // If authenticated, check if app is installed
      if (isAuthenticated) {
        try {
          // Get user's installed apps
          const installedApps = await api.app.getInstalledApps();

          // Check if this app is installed
          const isInstalled = installedApps.some(app => app.packageName === pkgName);

          // Update app with installed status
          appDetails.isInstalled = isInstalled;

          if (isInstalled) {
            // Find installed date from the installed apps
            const installedApp = installedApps.find(app => app.packageName === pkgName);
            if (installedApp && installedApp.installedDate) {
              appDetails.installedDate = installedApp.installedDate;
            }
          }
        } catch (err) {
          console.error('Error checking install status:', err);
          // Continue with app details, but without install status
        }
      }

      setApp(appDetails);
    } catch (err) {
      console.error('Error fetching app details:', err);
      setError('Failed to load app details. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle app installation
  const handleInstall = async () => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }

    if (!app) return;

    try {
      setInstallingApp(true);

      const success = await api.app.installApp(app.packageName);

      if (success) {
        toast.success('App installed successfully');
        setApp(prev => prev ? { ...prev, isInstalled: true, installedDate: new Date().toISOString() } : null);
      } else {
        toast.error('Failed to install app');
      }
    } catch (err) {
      console.error('Error installing app:', err);
      toast.error('Failed to install app');
    } finally {
      setInstallingApp(false);
    }
  };

  // Handle app uninstallation
  const handleUninstall = async () => {
    if (!isAuthenticated || !app) return;

    try {
      setInstallingApp(true);

      // First stop the app
      // const stopSuccess = await api.app.stopApp(app.packageName);
      // if (!stopSuccess) {
      //   toast.error('Failed to stop app before uninstallation');
      //   return;
      // }
      // App should be stopped automatically by the backend when uninstalling.

      // Then uninstall the app
      console.log('Uninstalling app:', app.packageName);
      const uninstallSuccess = await api.app.uninstallApp(app.packageName);

      if (uninstallSuccess) {
        toast.success('App uninstalled successfully');
        setApp(prev => prev ? { ...prev, isInstalled: false, installedDate: undefined } : null);
      } else {
        toast.error('Failed to uninstall app');
      }
    } catch (err) {
      console.error('Error uninstalling app:', err);
      toast.error('Failed to uninstall app. Please try again.');
    } finally {
      setInstallingApp(false);
    }
  };

  // Formatted date for display
  const formatDate = (dateString?: string) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <Header />

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6">
        {/* Back button */}
        <button
          onClick={() => navigate('/')}
          className="flex items-center text-blue-600 hover:text-blue-800 mb-6"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to AugmentOS Store
        </button>

        {/* Loading state */}
        {isLoading && (
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
          </div>
        )}

        {/* Error message */}
        {error && !isLoading && (
          <div className="my-4 max-w-2xl mx-auto p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            <p>{error}</p>
            <button
              className="mt-2 text-sm font-medium text-red-700 hover:text-red-600"
              onClick={() => packageName && fetchAppDetails(packageName)}
            >
              Try Again
            </button>
          </div>
        )}

        {/* App details */}
        {!isLoading && !error && app && (
          <div className="max-w-4xl mx-auto">
            {/* Hero section */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
              <div className="p-6">
                <div className="flex flex-col md:flex-row items-start">
                  {/* App logo */}
                  <img
                    src={app.logoURL}
                    alt={`${app.name} logo`}
                    className="w-24 h-24 object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = "https://placehold.co/96x96/gray/white?text=App";
                    }}
                  />

                  {/* App info */}
                  <div className="md:ml-6 mt-4 md:mt-0 flex-1">
                    <h1 className="text-2xl font-bold text-gray-900">{app.name}</h1>

                    {/* Organization name with link to filtered app store */}
                    <p className="text-sm text-gray-500">
                      {app.organizationId ? (
                        <button
                          onClick={() => navigateToOrgApps(app.organizationId!)}
                          className="hover:text-blue-600 hover:underline focus:outline-none"
                        >
                          {app.orgName || app.developerProfile?.company || app.developerId || ''}
                        </button>
                      ) : (
                        app.orgName || app.developerProfile?.company || app.developerId || ''
                      )}
                    </p>
                    {/* Debug details - Remove 'hidden' class to view in browser */}
                    <div className="text-xs text-gray-400 mt-1 hidden">
                      DeveloperID: {JSON.stringify(app.developerId)}<br/>
                      OrgID: {JSON.stringify(app.organizationId)}<br/>
                      OrgName: {JSON.stringify(app.orgName)}<br/>
                      Profile Company: {JSON.stringify(app.developerProfile?.company)}<br/>
                      Full Profile: {JSON.stringify(app.developerProfile)}
                    </div>

                    <div className="mt-4 flex flex-col gap-2">
                      {isAuthenticated ? (
                        app.isInstalled ? (
                          <Button
                            variant="destructive"
                            onClick={handleUninstall}
                            disabled={installingApp}
                            className="w-full md:w-48 bg-[#E24A24] hover:bg-[#E24A24]/90"
                          >
                            {installingApp ? (
                              <>
                                <div className="animate-spin h-4 w-4 border-2 border-gray-500 border-t-transparent rounded-full mr-2"></div>
                                Uninstalling...
                              </>
                            ) : (
                              <>
                                <X className="h-4 w-4 mr-1" />
                                Uninstall
                              </>
                            )}
                          </Button>
                        ) : (
                          <Button
                            onClick={handleInstall}
                            disabled={installingApp}
                            className="w-full md:w-48"
                          >
                            {installingApp ? (
                              <>
                                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2"></div>
                                Installing...
                              </>
                            ) : (
                              <>
                                <Download className="h-4 w-4 mr-1" />
                                Install
                              </>
                            )}
                          </Button>
                        )
                      ) : (
                        <Button
                          onClick={() => navigate('/login', { state: { returnTo: location.pathname } })}
                          className="bg-blue-600 hover:bg-blue-700 w-full md:w-48"
                        >
                          Sign in to install
                        </Button>
                      )}

                      {app.webviewURL && (
                        <Button variant="outline" asChild className="w-full md:w-48">
                          <a href={app.webviewURL} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="h-4 w-4 mr-1" />
                            Open Website
                          </a>
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* App details sections */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Left side: description and permissions */}
              <div className="md:col-span-2">
                {/* About section */}
                <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
                  <div className="p-6">
                    <h2 className="text-xl font-semibold mb-4">About this app</h2>
                    <p className="text-gray-700 whitespace-pre-line">
                      {app.description || 'No description available.'}
                    </p>
                  </div>
                </div>

                {/* Permissions section - moved here from the right column */}
                {(app.permissions && app.permissions.length > 0)  && (
                  <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                    <div className="p-6">
                      <h2 className="text-xl font-semibold mb-4">Required Permissions</h2>
                      <AppPermissions permissions={app.permissions} />
                    </div>
                  </div>
                )}

              </div>

              {/* Right side: additional details */}
              <div>
                {/* App Details Section */}
                <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
                  <div className="p-6">
                    <h2 className="text-xl font-semibold mb-4">App Details</h2>

                    <div className="space-y-4">
                      <div className="flex items-start">
                        <Package className="h-5 w-5 text-gray-400 mt-0.5 mr-3" />
                        <div>
                          <p className="text-sm font-medium text-gray-700">Package Name</p>
                          <p className="text-sm text-gray-500">{app.packageName}</p>
                        </div>
                      </div>

                      {app.version && (
                        <div className="flex items-start">
                          <Info className="h-5 w-5 text-gray-400 mt-0.5 mr-3" />
                          <div>
                            <p className="text-sm font-medium text-gray-700">Version</p>
                            <p className="text-sm text-gray-500">{app.version}</p>
                          </div>
                        </div>
                      )}

                      {app.tpaType && (
                        <div className="flex items-start">
                          <Star className="h-5 w-5 text-gray-400 mt-0.5 mr-3" />
                          <div>
                            <p className="text-sm font-medium text-gray-700">App Type</p>
                            <p className="text-sm text-gray-500 capitalize">{app.tpaType}</p>
                          </div>
                        </div>
                      )}

                      {app.isInstalled && app.installedDate && (
                        <div className="flex items-start">
                          <Calendar className="h-5 w-5 text-gray-400 mt-0.5 mr-3" />
                          <div>
                            <p className="text-sm font-medium text-gray-700">Installed Date</p>
                            <p className="text-sm text-gray-500">{formatDate(app.installedDate)}</p>
                          </div>
                        </div>
                      )}

                      {app.createdAt && (
                        <div className="flex items-start">
                          <Clock className="h-5 w-5 text-gray-400 mt-0.5 mr-3" />
                          <div>
                            <p className="text-sm font-medium text-gray-700">Published Date</p>
                            <p className="text-sm text-gray-500">{formatDate(app.createdAt)}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Developer Info Section */}
                <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  <div className="p-6">
                    <h2 className="text-xl font-semibold mb-4">Developer Info</h2>

                    <div className="space-y-4">
                      {/* Organization Section */}
                      {(app.orgName || app.organizationId) && (
                        <div className="flex items-start">
                          <Building className="h-5 w-5 text-gray-400 mt-0.5 mr-3" />
                          <div>
                            <p className="text-sm font-medium text-gray-700">Organization</p>
                            {app.organizationId ? (
                              <button
                                onClick={() => navigateToOrgApps(app.organizationId!)}
                                className="text-sm text-blue-600 hover:underline focus:outline-none"
                              >
                                {app.orgName || 'View all apps from this organization'}
                              </button>
                            ) : (
                              <p className="text-sm text-gray-500">{app.orgName}</p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Show profile info if available */}
                      {app.developerProfile?.company && !app.orgName && (
                        <div className="flex items-start">
                          <Building className="h-5 w-5 text-gray-400 mt-0.5 mr-3" />
                          <div>
                            <p className="text-sm font-medium text-gray-700">Company</p>
                            <p className="text-sm text-gray-500">{app.developerProfile.company}</p>
                          </div>
                        </div>
                      )}

                      {app.developerProfile?.website && (
                        <div className="flex items-start">
                          <Globe className="h-5 w-5 text-gray-400 mt-0.5 mr-3" />
                          <div>
                            <p className="text-sm font-medium text-gray-700">Website</p>
                            <a
                              href={app.developerProfile.website}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-blue-500 hover:underline"
                            >
                              {app.developerProfile.website}
                            </a>
                          </div>
                        </div>
                      )}

                      {app.developerProfile?.contactEmail && (
                        <div className="flex items-start">
                          <Mail className="h-5 w-5 text-gray-400 mt-0.5 mr-3" />
                          <div>
                            <p className="text-sm font-medium text-gray-700">Contact</p>
                            <a
                              href={`mailto:${app.developerProfile.contactEmail}`}
                              className="text-sm text-blue-500 hover:underline"
                            >
                              {app.developerProfile.contactEmail}
                            </a>
                          </div>
                        </div>
                      )}

                      {app.developerProfile?.description && (
                        <div className="flex items-start">
                          <FileText className="h-5 w-5 text-gray-400 mt-0.5 mr-3" />
                          <div>
                            <p className="text-sm font-medium text-gray-700">About</p>
                            <p className="text-sm text-gray-500">{app.developerProfile.description}</p>
                          </div>
                        </div>
                      )}

                      {/* Show default message if no developer info available */}
                      {!app.developerProfile && !app.orgName && !app.organizationId && (
                        <div className="text-sm text-gray-500">
                          No developer information available.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default AppDetails;