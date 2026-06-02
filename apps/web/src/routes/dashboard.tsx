import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Eye, ListOrdered, Radar } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/stat-card';
import { LogsFeed } from '@/components/logs-feed';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { useDashboard, useLogs } from '@/lib/queries';
import { useLiveTopic, type LiveMessage } from '@/lib/ws';
import { timeAgo } from '@/lib/utils';
import type { EventLog } from '@/lib/types';

const DAY_MS = 24 * 60 * 60 * 1000;

function useHourlyBuckets(logs: EventLog[] | undefined): { hour: string; count: number }[] {
  return useMemo(() => {
    const now = new Date();
    const buckets: { hour: string; count: number; start: number }[] = [];
    for (let i = 23; i >= 0; i -= 1) {
      const slot = new Date(now.getTime() - i * 60 * 60 * 1000);
      slot.setMinutes(0, 0, 0);
      buckets.push({
        hour: `${String(slot.getHours()).padStart(2, '0')}:00`,
        count: 0,
        start: slot.getTime(),
      });
    }
    for (const log of logs ?? []) {
      const time = new Date(log.createdAt).getTime();
      for (let i = buckets.length - 1; i >= 0; i -= 1) {
        if (time >= buckets[i]!.start) {
          buckets[i]!.count += 1;
          break;
        }
      }
    }
    return buckets.map(({ hour, count }) => ({ hour, count }));
  }, [logs]);
}

export function DashboardPage(): React.JSX.Element {
  const dashboard = useDashboard();
  const recentFeed = useLogs({ limit: 10, offset: 0 });
  const since = useMemo(() => new Date(Date.now() - DAY_MS).toISOString(), []);
  const dayLogs = useLogs({ from: since, limit: 500, offset: 0 });

  const [feed, setFeed] = useState<EventLog[]>([]);
  useEffect(() => {
    if (recentFeed.data) setFeed(recentFeed.data.data);
  }, [recentFeed.data]);

  const onLive = useCallback((message: LiveMessage) => {
    if (message.event === 'created') {
      setFeed((prev) => [message.data as EventLog, ...prev].slice(0, 10));
    }
  }, []);
  useLiveTopic('logs', onLive);

  const buckets = useHourlyBuckets(dayLogs.data?.data);
  const stats = dashboard.data;
  const lastScan = stats?.recentScanCompleted;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active orders"
          value={stats?.activeOurListings ?? 0}
          icon={ListOrdered}
          loading={dashboard.isLoading}
        />
        <StatCard
          label="Watchlist size"
          value={stats?.watchlistSize ?? 0}
          icon={Eye}
          loading={dashboard.isLoading}
        />
        <StatCard
          label="Errors (24h)"
          value={stats?.recentErrors ?? 0}
          icon={AlertTriangle}
          loading={dashboard.isLoading}
          accent="danger"
        />
        <StatCard
          label="Last scan"
          value={lastScan ? timeAgo(lastScan.capturedAt) : '—'}
          hint={lastScan ? `${lastScan.skuCount} SKUs · ${lastScan.durationMs}ms` : 'no scans yet'}
          icon={Radar}
          loading={dashboard.isLoading}
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Events per hour · last 24h</CardTitle>
          <span className="text-xs text-muted-foreground">{stats?.totalEventLogToday ?? 0} today</span>
        </CardHeader>
        <CardContent>
          {dayLogs.isError ? (
            <ErrorState message={dayLogs.error.message} onRetry={() => void dayLogs.refetch()} />
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={buckets} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="hour"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    interval={3}
                  />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                  />
                  <Bar dataKey="count" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Live activity</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recentFeed.isLoading ? (
            <TableSkeleton rows={6} cols={3} />
          ) : recentFeed.isError ? (
            <ErrorState message={recentFeed.error.message} onRetry={() => void recentFeed.refetch()} />
          ) : feed.length === 0 ? (
            <EmptyState icon={<Activity className="size-8" />} title="No events yet" />
          ) : (
            <LogsFeed logs={feed} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
