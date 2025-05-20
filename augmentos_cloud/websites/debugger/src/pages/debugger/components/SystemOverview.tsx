interface SystemStats {
  activeSessions: number;
  totalSessions: number;
  activeTpas: number;
  totalTpas: number;
}

interface SystemOverviewProps {
  stats: SystemStats;
}

export function SystemOverview({ stats }: SystemOverviewProps) {
  return (
    <div className="bg-white p-4 border-b border-gray-200 shadow-sm">
      <h2 className="text-lg font-medium mb-2">System Overview</h2>
      <div className="flex gap-6">
        <div className="bg-gray-50 rounded p-2 flex gap-2 items-center border border-gray-200">
          <div className="font-medium">Active Sessions:</div>
          <div className="text-gray-900 font-bold">{stats.activeSessions}</div>
          <div className="text-gray-500">/ {stats.totalSessions}</div>
        </div>
        <div className="bg-gray-50 rounded p-2 flex gap-2 items-center border border-gray-200">
          <div className="font-medium">Active TPAs:</div>
          <div className="text-gray-900 font-bold">{stats.activeTpas}</div>
          <div className="text-gray-500">/ {stats.totalTpas}</div>
        </div>
      </div>
    </div>
  );
} 