import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PriceChart } from '@/components/price-chart';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { usePrices, useWatchlist } from '@/lib/queries';

const RANGES = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
] as const;

export function PricesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { skuKey: routeSku } = useParams<{ skuKey: string }>();
  const [days, setDays] = useState<number>(7);

  const watchlist = useWatchlist();
  const options = watchlist.data ?? [];
  const selectedSku = routeSku ?? options[0]?.skuKey;

  const prices = usePrices(selectedSku, days);
  const snapshots = prices.data ?? [];

  const selectSku = (sku: string): void => navigate(`/prices/${encodeURIComponent(sku)}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={selectedSku ?? ''} onValueChange={selectSku} disabled={options.length === 0}>
          <SelectTrigger className="w-full sm:w-64">
            <SelectValue placeholder="Select a watched SKU" />
          </SelectTrigger>
          <SelectContent>
            {options.map((entry) => (
              <SelectItem key={entry.id} value={entry.skuKey} className="font-mono">
                {entry.skuKey}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex gap-1 rounded-lg bg-muted p-1">
          {RANGES.map((range) => (
            <Button
              key={range.label}
              size="sm"
              variant={days === range.days ? 'secondary' : 'ghost'}
              onClick={() => setDays(range.days)}
            >
              {range.label}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-sm">{selectedSku ?? '—'}</CardTitle>
        </CardHeader>
        <CardContent>
          {watchlist.isLoading || (selectedSku && prices.isLoading) ? (
            <TableSkeleton rows={6} cols={1} />
          ) : options.length === 0 ? (
            <EmptyState title="Watchlist is empty" description="Add a SKU to start tracking prices." />
          ) : prices.isError ? (
            <ErrorState message={prices.error.message} onRetry={() => void prices.refetch()} />
          ) : snapshots.length === 0 ? (
            <EmptyState
              icon={<TrendingUp className="size-8" />}
              title="No price history yet"
              description="The bot records a snapshot on every successful scan of this SKU."
            />
          ) : (
            <PriceChart snapshots={snapshots} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
