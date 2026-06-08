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
import { useMarket, usePrices } from '@/lib/queries';

const RANGES = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
] as const;

export function PricesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { skuKey: routeSku } = useParams<{ skuKey: string }>();
  const [days, setDays] = useState<number>(7);

  // Source the picker from the items the bot actually tracks (those with price
  // snapshots), not the separate WatchlistEntry table.
  const market = useMarket();
  const options = market.data ?? [];
  const selectedSku = routeSku ?? options[0]?.skuKey;
  const selected = options.find((o) => o.skuKey === selectedSku);

  const prices = usePrices(selectedSku, days);
  const snapshots = prices.data ?? [];

  const selectSku = (sku: string): void => navigate(`/prices/${encodeURIComponent(sku)}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={selectedSku ?? ''} onValueChange={selectSku} disabled={options.length === 0}>
          <SelectTrigger className="w-full sm:w-80">
            <SelectValue placeholder="Select a tracked item" />
          </SelectTrigger>
          <SelectContent>
            {options.map((item) => (
              <SelectItem key={item.itemId} value={item.skuKey}>
                {item.name} <span className="text-muted-foreground">· {item.skuKey}</span>
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
          <CardTitle className="text-sm">
            {selected ? selected.name : (selectedSku ?? '—')}
            {selected ? <span className="ml-2 font-mono text-xs text-muted-foreground">{selected.skuKey}</span> : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {market.isLoading || (selectedSku && prices.isLoading) ? (
            <TableSkeleton rows={6} cols={1} />
          ) : options.length === 0 ? (
            <EmptyState
              title="No tracked items yet"
              description="The bot records snapshots as it scans; items appear here within a minute or two."
            />
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
