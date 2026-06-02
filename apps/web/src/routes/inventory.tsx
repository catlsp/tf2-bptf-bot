import { useState } from 'react';
import { Boxes } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { useInventory } from '@/lib/queries';
import { formatRef, timeAgo, formatTimestamp } from '@/lib/utils';
import type { InventoryStatus } from '@/lib/types';

const TABS = ['all', 'HELD', 'LISTED', 'RESERVED', 'SOLD'] as const;
type Tab = (typeof TABS)[number];

export function InventoryPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('all');
  const status = tab === 'all' ? undefined : (tab as InventoryStatus);
  const query = useInventory(status);
  const items = query.data ?? [];

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
      <TabsList>
        {TABS.map((option) => (
          <TabsTrigger key={option} value={option}>
            {option === 'all' ? 'All' : option}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value={tab}>
        <Card>
          <CardContent className="p-0">
            {query.isLoading ? (
              <TableSkeleton rows={6} cols={5} />
            ) : query.isError ? (
              <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
            ) : items.length === 0 ? (
              <EmptyState
                icon={<Boxes className="size-8" />}
                title="Nothing here yet"
                description="The bot hasn’t bought anything yet — items show up once a trade is accepted."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Asset ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Acquired price</TableHead>
                    <TableHead>Acquired</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-medium">{item.item.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{item.item.skuKey}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {item.assetId}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={item.status} />
                      </TableCell>
                      <TableCell className="tabular-nums">{formatRef(item.acquiredPriceRef)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground" title={formatTimestamp(item.acquiredAt)}>
                        {timeAgo(item.acquiredAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
