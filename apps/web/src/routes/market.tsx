import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpDown, Search, TrendingUp } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { useMarket } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { formatRef, timeAgo, formatTimestamp } from '@/lib/utils';
import type { MarketItem } from '@/lib/types';

type SortKey = 'spread' | 'buy' | 'name';

function spreadPct(item: MarketItem): number | null {
  if (item.buyRef == null || item.sellRef == null || item.buyRef <= 0) return null;
  return Number((((item.sellRef - item.buyRef) / item.buyRef) * 100).toFixed(0));
}

export function MarketPage(): React.JSX.Element {
  const navigate = useNavigate();
  const query = useMarket();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('spread');
  const term = useDebouncedValue(search.trim().toLowerCase());

  const rows = useMemo(() => {
    const items = (query.data ?? []).filter(
      (i) => term === '' || i.name.toLowerCase().includes(term) || i.skuKey.toLowerCase().includes(term),
    );
    const sorted = [...items];
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'buy') sorted.sort((a, b) => (b.buyRef ?? 0) - (a.buyRef ?? 0));
    else sorted.sort((a, b) => (b.spreadRef ?? -Infinity) - (a.spreadRef ?? -Infinity));
    return sorted;
  }, [query.data, term, sort]);

  const cycleSort = (): void =>
    setSort((s) => (s === 'spread' ? 'buy' : s === 'buy' ? 'name' : 'spread'));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search item or SKU…"
            className="pl-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={cycleSort} className="sm:ml-auto">
          <ArrowUpDown className="size-4" />
          Sort: {sort}
        </Button>
        <span className="text-xs text-muted-foreground">{rows.length} tracked</span>
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <TableSkeleton rows={10} cols={6} />
          ) : query.isError ? (
            <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<TrendingUp className="size-8" />}
              title="No market data yet"
              description="The bot records a snapshot per SKU each scan; data appears within a minute or two."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">Top buy</TableHead>
                  <TableHead className="text-right">Top sell</TableHead>
                  <TableHead className="text-right">Spread</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => {
                  const pct = spreadPct(item);
                  return (
                    <TableRow
                      key={item.itemId}
                      className="cursor-pointer"
                      onClick={() => navigate(`/prices/${encodeURIComponent(item.skuKey)}`)}
                    >
                      <TableCell className="font-medium">{item.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{item.skuKey}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {item.buyRef != null ? formatRef(item.buyRef) : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {item.sellRef != null ? formatRef(item.sellRef) : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {item.spreadRef != null ? (
                          <Badge variant={item.spreadRef > 0 ? 'success' : 'secondary'}>
                            {item.spreadRef > 0 ? '+' : ''}
                            {item.spreadRef} ref{pct != null ? ` · ${pct}%` : ''}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell
                        className="text-right text-xs text-muted-foreground"
                        title={formatTimestamp(item.capturedAt)}
                      >
                        {timeAgo(item.capturedAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
