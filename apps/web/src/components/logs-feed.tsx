import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { EventLog } from '@/lib/types';
import { cn, formatTimestamp, timeAgo } from '@/lib/utils';
import { StatusBadge } from '@/components/status-badge';

function LogRow({ log, expandable }: { log: EventLog; expandable: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const hasPayload = log.payload !== null && log.payload !== undefined;
  const canExpand = expandable && hasPayload;

  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm',
          canExpand && 'hover:bg-muted/40',
          !canExpand && 'cursor-default',
        )}
      >
        {expandable ? (
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              !hasPayload && 'opacity-0',
              open && 'rotate-90',
            )}
          />
        ) : null}
        <StatusBadge status={log.level} />
        <code className="shrink-0 text-xs text-muted-foreground">{log.type}</code>
        <span className="min-w-0 flex-1 truncate text-foreground">{log.message}</span>
        <time
          className="shrink-0 text-xs text-muted-foreground"
          title={formatTimestamp(log.createdAt)}
        >
          {timeAgo(log.createdAt)}
        </time>
      </button>
      {open && hasPayload ? (
        <pre className="overflow-auto bg-background px-4 pb-3 pl-11 text-xs text-muted-foreground">
          {JSON.stringify(log.payload, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export function LogsFeed({
  logs,
  expandable = false,
}: {
  logs: EventLog[];
  expandable?: boolean;
}): React.JSX.Element {
  return (
    <div className="divide-y divide-border">
      {logs.map((log) => (
        <LogRow key={log.id} log={log} expandable={expandable} />
      ))}
    </div>
  );
}
