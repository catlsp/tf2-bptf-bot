import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pause, Play, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LogsFeed } from '@/components/logs-feed';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { useLogTypes, useLogs } from '@/lib/queries';
import { useLiveTopic } from '@/lib/ws';

const PAGE_SIZE = 50;
const LEVELS = ['all', 'info', 'warn', 'error'] as const;

function toIso(localValue: string): string | undefined {
  if (!localValue) return undefined;
  const date = new Date(localValue);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function LogsPage(): React.JSX.Element {
  const client = useQueryClient();
  const [type, setType] = useState('all');
  const [level, setLevel] = useState<string>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [live, setLive] = useState(true);

  const types = useLogTypes();
  const params = {
    type: type === 'all' ? undefined : type,
    level: level === 'all' ? undefined : level,
    from: toIso(from),
    to: toIso(to),
    limit: PAGE_SIZE,
    offset,
  };
  const query = useLogs(params);

  // When live and viewing the first page, refetch on each new event so the feed
  // stays current while still honouring the active filters (server-side).
  const onLive = useCallback(() => {
    if (live && offset === 0) void client.invalidateQueries({ queryKey: ['logs'] });
  }, [client, live, offset]);
  useLiveTopic('logs', onLive);

  const updateFilter = (apply: () => void): void => {
    setOffset(0);
    apply();
  };

  const clearFilters = (): void => {
    setOffset(0);
    setType('all');
    setLevel('all');
    setFrom('');
    setTo('');
  };

  const hasFilters = type !== 'all' || level !== 'all' || from !== '' || to !== '';
  const logs = query.data?.data ?? [];
  const total = query.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Type</span>
          <Select value={type} onValueChange={(value) => updateFilter(() => setType(value))}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {(types.data ?? []).map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Level</span>
          <Select value={level} onValueChange={(value) => updateFilter(() => setLevel(value))}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVELS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option === 'all' ? 'All levels' : option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">From</span>
          <Input
            type="datetime-local"
            value={from}
            onChange={(event) => updateFilter(() => setFrom(event.target.value))}
            className="w-52"
          />
        </div>
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">To</span>
          <Input
            type="datetime-local"
            value={to}
            onChange={(event) => updateFilter(() => setTo(event.target.value))}
            className="w-52"
          />
        </div>

        {hasFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-4" />
            Clear
          </Button>
        ) : null}

        <Button
          variant={live ? 'secondary' : 'outline'}
          size="sm"
          className="ml-auto"
          onClick={() => setLive((value) => !value)}
        >
          {live ? <Pause className="size-4" /> : <Play className="size-4" />}
          {live ? 'Live' : 'Paused'}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <TableSkeleton rows={10} cols={3} />
          ) : query.isError ? (
            <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
          ) : logs.length === 0 ? (
            <EmptyState title="No log entries match these filters" />
          ) : (
            <>
              <LogsFeed logs={logs} expandable />
              <Pagination offset={offset} limit={PAGE_SIZE} total={total} onOffsetChange={setOffset} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
