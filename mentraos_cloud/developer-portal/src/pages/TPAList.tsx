// pages/TPAList.tsx
import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { useNavigate } from 'react-router-dom';
import { Plus } from "lucide-react";
import DashboardLayout from "../components/DashboardLayout";
import TPATable from "../components/TPATable";
import api, { AppResponse } from '../services/api.service';
import { useAuth } from '../hooks/useAuth';
import { useOrganization } from '../context/OrganizationContext';

const TPAList: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading, tokenReady } = useAuth();
  const { currentOrg, loading: orgLoading } = useOrganization();

  // State for TPA data
  const [tpas, setTpas] = useState<AppResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch TPAs from API
  useEffect(() => {
    // Debounce timer to prevent rapid re-fetches
    let timeoutId: NodeJS.Timeout;

    const fetchTPAs = async () => {
      if (!isAuthenticated) return;
      if (!tokenReady) {
        console.log('Token not ready yet, waiting before fetching TPAs...');
        return;
      }
      if (!currentOrg) {
        console.log('No organization selected, waiting...');
        return;
      }

      setIsLoading(true);
      try {
        console.log('Fetching TPAs for organization:', currentOrg.name);
        const tpaData = await api.apps.getAll(currentOrg.id);
        setTpas(tpaData);
        setError(null);
      } catch (err) {
        console.error('Failed to fetch TPAs:', err);
        setError('Failed to load TPAs. Please try again.');
      } finally {
        setIsLoading(false);
      }
    };

    if (!authLoading && !orgLoading) {
      // Debounce the fetch to prevent rapid re-fetches on focus changes
      timeoutId = setTimeout(fetchTPAs, 100);
    }

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [isAuthenticated, authLoading, tokenReady, currentOrg?.id, orgLoading]);

  // Handle TPA deletion
  const handleTpaDeleted = (packageName: string) => {
    setTpas(tpas.filter(tpa => tpa.packageName !== packageName));
  };

  // Handle TPA update
  const handleTpaUpdated = (updatedTpa: AppResponse) => {
    setTpas(prevTpas =>
      prevTpas.map(tpa =>
        tpa.packageName === updatedTpa.packageName ? updatedTpa : tpa
      )
    );
  };

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">My Apps</h1>
          <Button
            className="gap-2"
            onClick={() => navigate('/tpas/create')}
          >
            <Plus className="h-4 w-4" />
            Create App
          </Button>
        </div>

        <TPATable
          tpas={tpas}
          isLoading={isLoading}
          error={error}
          showSearch={true}
          showViewAll={false}
          onTpaDeleted={handleTpaDeleted}
          onTpaUpdated={handleTpaUpdated}
        />
      </div>
    </DashboardLayout>
  );
};

export default TPAList;