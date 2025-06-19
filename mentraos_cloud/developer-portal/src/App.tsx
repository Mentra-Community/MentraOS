// App.tsx
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

// Components
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';

// Pages
import LandingPage from './pages/LandingPage';
import DashboardHome from './pages/DashboardHome';

import LoginOrSignup from './pages/AuthPage';
import TPAList from './pages/TPAList';
import CreateTPA from './pages/CreateTPA';
import EditTPA from './pages/EditTPA';
import OrganizationSettings from './pages/OrganizationSettings';
import Members from './pages/Members';
import AdminPanel from './pages/AdminPanel';
import NotFound from './pages/NotFound';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { OrganizationProvider } from './context/OrganizationContext';

// Protected route component
function ProtectedRoute({ children, requireAdmin = false }: { children: React.ReactNode, requireAdmin?: boolean }) {
  const { isAuthenticated, isLoading, user, session } = useAuth();
  const [isAdmin, setIsAdmin] = React.useState<boolean | null>(null);
  const [isCheckingAdmin, setIsCheckingAdmin] = React.useState(false);

  // Check admin status if required
  React.useEffect(() => {
    async function checkAdminStatus() {
      if (requireAdmin && isAuthenticated && !isLoading) {
        setIsCheckingAdmin(true);
        try {
          const api = (await import('./services/api.service')).default;
          const result = await api.admin.checkAdmin();
          setIsAdmin(result && result.isAdmin);
        } catch (error) {
          setIsAdmin(false);
        } finally {
          setIsCheckingAdmin(false);
        }
      }
    }

    //checkAdminStatus();
  }, [requireAdmin, isAuthenticated, isLoading]);

  // Only log authentication issues in development mode
  if (process.env.NODE_ENV === 'development' && !isAuthenticated && !isLoading) {
    console.log('Auth issue:', { isAuthenticated, isLoading, hasUser: !!user, hasSession: !!session });
  }

  if (isLoading || (requireAdmin && isCheckingAdmin)) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    console.log('Not authenticated, redirecting to signin page');
    return <Navigate to="/signin" replace />;
  }

  if (requireAdmin && isAdmin === false) {
    console.log('Not admin, redirecting to dashboard');
    return <Navigate to="/dashboard" replace />;
  }

  // Authentication (and admin check if required) successful
  return <>{children}</>;
}

const App: React.FC = () => {
  return (
    <AuthProvider>
      <OrganizationProvider>
        <Toaster />
        <TooltipProvider>
        <BrowserRouter>
          <Routes>
            {/* Public Routes */}
            <Route path="/" element={<LandingPage />} />

            {/* Login or Signup */}
            <Route path="/login" element={<LoginOrSignup />} />
            <Route path="/signup" element={<LoginOrSignup />} />
            <Route path="/signin" element={<LoginOrSignup />} />

            {/* Organization Invite */}
            <Route path="/invite/accept" element={<LoginOrSignup />} />

            {/* Dashboard Routes - No auth for now */}
            <Route path="/dashboard" element={
              <ProtectedRoute>
                <DashboardHome />
              </ProtectedRoute>
            } />
            <Route path="/tpas" element={
              <ProtectedRoute>
                <TPAList />
              </ProtectedRoute>
            } />
            <Route path="/tpas/create" element={
              <ProtectedRoute>
                <CreateTPA />
              </ProtectedRoute>
            } />
            <Route path="/tpas/:packageName/edit" element={
              <ProtectedRoute>
                <EditTPA />
              </ProtectedRoute>
            } />

            <Route path="/org-settings" element={
              <ProtectedRoute>
                <OrganizationSettings />
              </ProtectedRoute>
            } />

            <Route path="/members" element={
              <ProtectedRoute>
                <Members />
              </ProtectedRoute>
            } />

            <Route path="/admin" element={
              <ProtectedRoute requireAdmin={true}>
                <AdminPanel />
              </ProtectedRoute>
            } />

            {/* Catch-all Not Found route */}
            <Route path="*" element={<NotFound />} />
            <Route path="*" element={<LandingPage />} />
          </Routes>
        </BrowserRouter>
        </TooltipProvider>
      </OrganizationProvider>
    </AuthProvider>
  );
};

export default App;