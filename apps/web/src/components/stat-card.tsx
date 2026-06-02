import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  loading,
  accent,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: LucideIcon;
  loading?: boolean;
  accent?: 'default' | 'danger';
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className="flex items-start justify-between p-5">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <p
              className={cn(
                'text-3xl font-semibold tabular-nums',
                accent === 'danger' && Number(value) > 0 ? 'text-destructive' : 'text-foreground',
              )}
            >
              {value}
            </p>
          )}
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <div className="rounded-md bg-muted p-2 text-muted-foreground">
          <Icon className="size-5" />
        </div>
      </CardContent>
    </Card>
  );
}
