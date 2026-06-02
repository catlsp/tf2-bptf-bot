import { NavLink } from 'react-router-dom';
import { Boxes } from 'lucide-react';
import { cn, timeAgo } from '@/lib/utils';
import { useUiStore } from '@/lib/store';
import { useDashboard } from '@/lib/queries';
import { NAV_ITEMS } from './nav';

function LiveDot({ color }: { color: string }): React.JSX.Element {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', color)} />;
}

function StatusFooter(): React.JSX.Element {
  const liveStatus = useUiStore((state) => state.liveStatus);
  const { data } = useDashboard();

  const liveColor =
    liveStatus === 'open' ? 'bg-success' : liveStatus === 'connecting' ? 'bg-warning' : 'bg-destructive';
  const liveLabel =
    liveStatus === 'open' ? 'Live connected' : liveStatus === 'connecting' ? 'Connecting…' : 'Disconnected';

  const lastScan = data?.recentScanCompleted?.capturedAt;
  const scanAgeMs = lastScan ? Date.now() - new Date(lastScan).getTime() : null;
  const botOnline = scanAgeMs !== null && scanAgeMs < 5 * 60_000;

  return (
    <div className="space-y-2 border-t border-border p-4 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <LiveDot color={liveColor} />
        <span>{liveLabel}</span>
      </div>
      <div className="flex items-center gap-2">
        <LiveDot color={botOnline ? 'bg-success' : 'bg-muted-foreground'} />
        <span>
          {lastScan ? `Bot scan ${timeAgo(lastScan)}` : 'Bot: no scans yet'}
        </span>
      </div>
    </div>
  );
}

export function Sidebar(): React.JSX.Element {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Boxes className="size-5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold">bptf bot</p>
          <p className="text-xs text-muted-foreground">management panel</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )
            }
          >
            <item.icon className="size-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <StatusFooter />
    </aside>
  );
}
