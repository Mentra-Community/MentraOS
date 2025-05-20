import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Download, X, Lock } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import api from '../api';
import { AppI } from '../types';
import Header from '../components/Header';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

const AppStore: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apps, setApps] = useState<AppI[]>([]);
  const [installingApp, setInstallingApp] = useState<string | null>(null);

  // Fetch apps on component mount
  useEffect(() => {
    fetchApps();
  }, [isAuthenticated]); // Re-fetch when authentication state changes
  
  // Fetch available apps and installed status
  const fetchApps = async () => {
    try {
      setIsLoading(true);
      setError(null);

      let appList: AppI[] = [];
      let installedApps: AppI[] = [];

      // Get the available apps (public list for everyone)
      try {
        // appList = await api.app.getPublicApps();
        appList = await api.app.getAvailableApps();
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

  // Handle search submit
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!searchQuery.trim()) {
      fetchApps(); // If search query is empty, reset to all apps
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const results = await api.app.searchApps(searchQuery);

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

  // Handle app installation
  const handleInstall = async (packageName: string) => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }

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
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <Header />

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6">
        {/* Search bar */}
        <form onSubmit={handleSearch} className="relative mt-4 max-w-2xl mx-auto">
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
            <Search className="h-5 w-5 text-gray-400" />
          </div>
          <input
            type="text"
            className="bg-gray-100 w-full pl-10 pr-4 py-2 rounded-lg text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Search apps..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex items-center pr-3"
              onClick={() => {
                setSearchQuery('');
                fetchApps(); // Reset to all apps
              }}
            >
              <X className="h-5 w-5 text-gray-400 hover:text-gray-600" />
            </button>
          )}
        </form>

        {/* Search result indicator */}
        {searchQuery && (
          <div className="my-4 max-w-2xl mx-auto">
            <p className="text-gray-600">
              {filteredApps.length} {filteredApps.length === 1 ? 'result' : 'results'} for "{searchQuery}"
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
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {filteredApps.map(app => (
              <div
                key={app.packageName}
                className="bg-white rounded-lg border border-gray-200 overflow-hidden h-full flex flex-col"
              >
                <div className="p-4 flex flex-col flex-1">
                  <div 
                    className="flex items-start cursor-pointer"
                    onClick={() => navigate(`/package/${app.packageName}`)}
                  >
                    <img
                      src={app.logoURL}
                      alt={`${app.name} logo`}
                      className="w-12 h-12 object-cover rounded-lg"
                      onError={(e) => {
                        // Fallback for broken images
                        (e.target as HTMLImageElement).src = "https://placehold.co/48x48/gray/white?text=App";
                      }}
                    />
                    <div className="ml-3 flex-1">
                      <h3 className="font-medium text-gray-900">{app.name}</h3>
                      <p className="text-xs text-gray-500">
                        {app.developerProfile?.company || app.developerId || ''}
                      </p>
                    </div>
                  </div>
                  <p 
                    className="mt-3 text-sm text-gray-600 line-clamp-3 cursor-pointer flex-grow" 
                    onClick={() => navigate(`/package/${app.packageName}`)}
                  >
                    {app.description || 'No description available.'}
                  </p>
                  <div className="mt-4">
                    {isAuthenticated ? (
                      app.isInstalled ? (
                        <Button
                          onClick={() => handleUninstall(app.packageName)}
                          variant="destructive"
                          disabled={installingApp === app.packageName}
                          className="w-full bg-[#E24A24] hover:bg-[#E24A24]/90"
                        >
                          {installingApp === app.packageName ? (
                            <>
                              <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2"></div>
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
                          onClick={() => handleInstall(app.packageName)}
                          disabled={installingApp === app.packageName}
                          className="w-full"
                        >
                          {installingApp === app.packageName ? (
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
                        onClick={() => navigate('/login')}
                        className="w-full"
                      >
                        <Lock className="h-4 w-4 mr-1" />
                        Sign in to install
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !error && filteredApps.length === 0 && (
          <div className="text-center py-12">
            {searchQuery ? (
              <>
                <p className="text-gray-500 text-lg">No apps found for "{searchQuery}"</p>
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
              <p className="text-gray-500 text-lg">No apps available at this time.</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default AppStore;