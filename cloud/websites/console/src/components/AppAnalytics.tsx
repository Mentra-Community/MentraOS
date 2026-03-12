import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@mentra/shared";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Loader2, Users, UserCheck, TrendingUp, Download } from "lucide-react";
import api from "@/services/api.service";

interface AppAnalytics {
  totalInstalls: number;
  dau: number;
  wau: number;
  mau: number;
  installsOverTime: { date: string; count: number }[];
}

interface AppAnalyticsProps {
  packageName: string;
}

export default function AppAnalytics({ packageName }: AppAnalyticsProps) {
  const [analytics, setAnalytics] = useState<AppAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.console.apps
      .getAnalytics(packageName)
      .then((data: AppAnalytics) => {
        if (!cancelled) setAnalytics(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || "Failed to load analytics");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [packageName]);

  if (loading) {
    return (
      <Card className="shadow-sm border-border/60">
        <CardContent className="p-6 flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="shadow-sm border-border/60">
        <CardContent className="p-6 text-center text-muted-foreground text-sm">
          Unable to load analytics
        </CardContent>
      </Card>
    );
  }

  if (!analytics) return null;

  const stats = [
    { label: "Total Installs", value: analytics.totalInstalls, icon: Download },
    { label: "Daily Active", value: analytics.dau, icon: UserCheck },
    { label: "Weekly Active", value: analytics.wau, icon: Users },
    { label: "Monthly Active", value: analytics.mau, icon: TrendingUp },
  ];

  // Fill in missing days in the last 30 days for a complete chart
  const chartData = fillMissingDays(analytics.installsOverTime, 30);

  return (
    <Card className="shadow-sm border-border/60">
      <CardHeader className="pb-4 pt-6 px-6">
        <CardTitle className="text-lg font-semibold">Analytics</CardTitle>
      </CardHeader>
      <CardContent className="px-6 pb-6 space-y-6">
        {/* Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-lg border border-border/60 p-4"
            >
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <stat.icon className="h-4 w-4" />
                <span className="text-xs">{stat.label}</span>
              </div>
              <div className="text-2xl font-semibold">{stat.value}</div>
            </div>
          ))}
        </div>

        {/* Install Trend Chart */}
        {chartData.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">
              Installs — Last 30 Days
            </h3>
            <div className="h-[200px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const data = payload[0].payload;
                      return (
                        <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-md">
                          <div className="font-medium">{data.date}</div>
                          <div className="text-muted-foreground">
                            {data.count} install{data.count !== 1 ? "s" : ""}
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Bar
                    dataKey="count"
                    fill="hsl(var(--primary))"
                    radius={[3, 3, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Fill in days with 0 installs so the chart has no gaps. */
function fillMissingDays(
  data: { date: string; count: number }[],
  days: number,
): { date: string; label: string; count: number }[] {
  const map = new Map(data.map((d) => [d.date, d.count]));
  const result: { date: string; label: string; count: number }[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    result.push({
      date: dateStr,
      label,
      count: map.get(dateStr) || 0,
    });
  }

  return result;
}
