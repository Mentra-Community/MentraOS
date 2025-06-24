import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Download, X, Lock, Building } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import api, { AppFilterOptions } from '../api';
import { AppI } from '../types';
import Header from '../components/Header';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { isMobileDevice, openInApp } from '../utils/mobile';

/**
 * AppStore component that displays and manages available applications
 * Supports filtering by search query and organization ID (via URL parameter)
 */
const AppStore: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Get organization ID from URL query parameter
  const orgId = searchParams.get('orgId');

  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apps, setApps] = useState<AppI[]>([]);
  const [installingApp, setInstallingApp] = useState<string | null>(null);
  const [activeOrgFilter, setActiveOrgFilter] = useState<string | null>(orgId);
  const [orgName, setOrgName] = useState<string>('');

  // Fetch apps on component mount or when org filter changes
  useEffect(() => {
    setActiveOrgFilter(orgId);
    fetchApps();
  }, [isAuthenticated, orgId]); // Re-fetch when authentication state or org filter changes

  /**
   * Fetches available apps and installed status
   * Applies organization filter if present in URL
   */
  const fetchApps = async () => {
    try {
      setIsLoading(true);
      setError(null);

      let appList: AppI[] = [];
      let installedApps: AppI[] = [];

      // Get the available apps (public list for everyone)
      try {
        // If organizationId is provided, use it for filtering
        const filterOptions: AppFilterOptions = {};
        if (orgId) {
          filterOptions.organizationId = orgId;
        }

        appList = await api.app.getAvailableApps(orgId ? filterOptions : undefined);

        // If we're filtering by organization, get the organization name from the first app
        if (orgId && appList.length > 0) {
          const firstApp = appList[0];
          if (firstApp.orgName) {
            setOrgName(firstApp.orgName);
          } else {
            // Fallback to a generic name if orgName isn't available
            setOrgName('Selected Organization');
          }
        }
      } catch (err) {
        console.error('Error fetching public apps:', err);
        setError('Failed to load apps. Please try again.');
        return;
      }

      // If authenticated, fetch installed apps and merge with available apps
      if (isAuthenticated) {
        try {
          // Get user's installed apps
          installedApps = await api.app.getInstalledApps();

          // Create a map of installed apps for quick lookup
          const installedMap = new Map<string, boolean>();
          installedApps.forEach(app => {
            installedMap.set(app.packageName, true);
          });

          // Update the available apps with installed status
          appList = appList.map(app => ({
            ...app,
            isInstalled: installedMap.has(app.packageName)
          }));

          console.log('Merged apps with install status:', appList);
        } catch (err) {
          console.error('Error fetching installed apps:', err);
          // Continue with available apps, but without install status
        }
      }

      setApps(appList);
    } catch (err) {
      console.error('Error fetching apps:', err);
      setError('Failed to load apps. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Filter apps based on search query (client-side filtering now, adjust if needed for server-side)
  const filteredApps = searchQuery.trim() === ''
    ? apps
    : apps.filter(app =>
      app.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (app.description && app.description.toLowerCase().includes(searchQuery.toLowerCase()))
    );

  /**
   * Handles search form submission
   * Preserves organization filter when searching
   */
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!searchQuery.trim()) {
      fetchApps(); // If search query is empty, reset to all apps
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      // Search with the organization filter if present
      const filterOptions: AppFilterOptions = {};
      if (orgId) {
        filterOptions.organizationId = orgId;
      }

      const results = await api.app.searchApps(
        searchQuery,
        orgId ? filterOptions : undefined
      );

      // If authenticated, update the search results with installed status
      if (isAuthenticated) {
        try {
          // Get user's installed apps
          const installedApps = await api.app.getInstalledApps();

          // Create a map of installed apps for quick lookup
          const installedMap = new Map<string, boolean>();
          installedApps.forEach(app => {
            installedMap.set(app.packageName, true);
          });

          // Update search results with installed status
          results.forEach(app => {
            app.isInstalled = installedMap.has(app.packageName);
          });
        } catch (err) {
          console.error('Error updating search results with install status:', err);
        }
      }

      setApps(results);
    } catch (err) {
      console.error('Error searching apps:', err);
      toast.error('Failed to search apps');
      setError('Failed to search apps. Please try again.'); // Set error state for UI
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Clears the organization filter
   */
  const clearOrgFilter = () => {
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      newParams.delete('orgId');
      return newParams;
    });
    setActiveOrgFilter(null);
    setOrgName('');
  };

  const handleOpen = async (packageName: string) => {
    if (!isAuthenticated) {
      console.log("TODO not impleneted: Open App");
      return;
    }
  }
  // Handle app installation
  const handleInstall = async (packageName: string) => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }

    // On mobile devices, open in the MentraOS app
    if (isMobileDevice()) {
      openInApp(packageName);
      return;
    }

    // On desktop, use the web API
    try {
      setInstallingApp(packageName);

      const success = await api.app.installApp(packageName);

      if (success) {
        toast.success('App installed successfully');

        // Update the app in the list to show as installed
        setApps(prevApps =>
          prevApps.map(app =>
            app.packageName === packageName
              ? { ...app, isInstalled: true, installedDate: new Date().toISOString() }
              : app
          )
        );
      } else {
        toast.error('Failed to install app');
      }
    } catch (err) {
      console.error('Error installing app:', err);
      toast.error('Failed to install app');
    } finally {
      setInstallingApp(null);
    }
  };

  // Handle app uninstallation
  const handleUninstall = async (packageName: string) => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }

    try {
      console.log('Uninstalling app:', packageName);
      setInstallingApp(packageName);

      const success = await api.app.uninstallApp(packageName);

      if (success) {
        toast.success('App uninstalled successfully');

        // Update the app in the list to show as uninstalled
        setApps(prevApps =>
          prevApps.map(app =>
            app.packageName === packageName
              ? { ...app, isInstalled: false, installedDate: undefined }
              : app
          )
        );
      } else {
        toast.error('Failed to uninstall app');
      }
    } catch (err) {
      console.error('Error uninstalling app:', err);
      toast.error('Failed to uninstall app');
    } finally {
      setInstallingApp(null);
    }
  };

  return (
      <div className="min-h-screen bg-[#030514] text-white">      
      {/* Header */}
      <Header />

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6 ">
        {/* Search bar */}
        <form onSubmit={handleSearch} className="mt-4 max-w-2xl mx-auto flex items-center space-x-3">
          <div className="relative flex-1">
            <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
              <Search className="h-5 w-5 text-white" />
            </div>
            <input
              type="text"
              className="bg-[#141834] w-full pl-10 pr-4 py-2 rounded-3xl text-white placeholder-[#B3B3B3] focus:outline-none focus:ring-2 focus:ring-[#47478E]"
              placeholder="Search"
              value={searchQuery}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
            />
          </div>
          {searchQuery && (
            <button
              type="button"
              className="text-[#ABAAFF] text-[15px] font-normal tracking-[0.1em]"
              onClick={() => {
                setSearchQuery('');
                fetchApps(); // Reset to all apps
              }}
            >
              Cancel
            </button>
          )}
        </form>

        {/* Organization filter indicator */}
        {activeOrgFilter && (
          <div className="my-4 max-w-2xl mx-auto">
            <div className="flex items-center text-sm bg-blue-50 text-blue-700 px-3 py-2 rounded-md">
              <Building className="h-4 w-4 mr-2" />
              <span>
                Filtered by: <span className="font-medium">{orgName || 'Organization'}</span>
              </span>
              <button
                onClick={clearOrgFilter}
                className="ml-auto text-blue-600 hover:text-blue-800"
                aria-label="Clear organization filter"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Search result indicator */}
        {searchQuery && (
          <div className="my-4 max-w-2xl mx-auto">
            <p className="text-gray-600">
              {filteredApps.length} {filteredApps.length === 1 ? 'result' : 'results'} for "{searchQuery}"
              {activeOrgFilter && ` in ${orgName}`}
            </p>
          </div>
        )}

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
              onClick={fetchApps}
            >
              Try Again
            </button>
          </div>
        )}

        {/* App grid */}
        {!isLoading && !error && (
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-3">
            {filteredApps.map(app => (
              <div
                key={app.packageName}
                className=" shadow-sm overflow-hidden h-full flex flex-col"
              >
                <div className="p-3 flex flex-col flex-1">
                  <div className="flex items-start">
                    <div
                      className="flex-1 cursor-pointer flex items-center"
                      onClick={() => navigate(`/package/${app.packageName}`)}
                    >
                      <img
                        src={app.logoURL}
                        alt={`${app.name} logo`}
                        className="w-14 h-14 object-cover rounded-full border border-[#3C3C5C]"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = "https://placehold.co/48x48/gray/white?text=App";
                        }}
                      />
                      <div className="ml-3">
                        <h3 className="text-white font-semibold text-[16px]">{app.name}</h3>
                        <p className="text-[13px] text-[#8E8EA0] mt-[2px]">
                          {app.orgName || app.developerProfile?.company || app.developerId || ''}
                        </p>
                      </div>
                    </div>
                    <div className="ml-3 mt-1">
                      {isAuthenticated ? (
                        app.isInstalled ? (
                          <Button
                            onClick={() => handleOpen(app.packageName)}
                            disabled={installingApp === app.packageName}
                            className="bg-[#242454] text-white text-[15px] font-normal tracking-[0.1em] px-4 py-[6px] rounded-full w-fit h-fit self-center"
                          >
                            <>Open</>
                          </Button>
                        ) : (
                          <Button
                            onClick={() => handleInstall(app.packageName)}
                            disabled={installingApp === app.packageName}
                            className="bg-[#242454] text-white text-[15px] font-normal tracking-[0.1em] px-4 py-[6px] rounded-full w-fit h-fit self-center"
                          >
                            {installingApp === app.packageName ? (
                              <>
                                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2"></div>
                                Installing
                              </>
                            ) : (
                              <>Get</>
                            )}
                          </Button>
                        )
                      ) : (
                        <Button
                          onClick={() => navigate('/login')}
                          className="w-full bg-[#2E2E5E] text-white hover:bg-[#3A3A70]"
                        >
                          <Lock className="h-4 w-4 mr-1" />
                          Sign in
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
                <div className="border-b border-[#2D2D46] mt-2" />
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !error && filteredApps.length === 0 && (
          <div className="text-center py-12">
            {searchQuery ? (
              <>
                <p className="text-gray-500 text-lg">
                  No apps found for "{searchQuery}"
                  {activeOrgFilter && ` in ${orgName}`}
                </p>
                <button
                  className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                  onClick={() => {
                    setSearchQuery('');
                    fetchApps(); // Reset to all apps
                  }}
                >
                  Clear Search
                </button>
              </>
            ) : (
              <p className="text-gray-500 text-lg">
                {activeOrgFilter
                  ? `No apps available for ${orgName}.`
                  : "No apps available at this time."}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default AppStore;