import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { useTrades } from '@/lib/queries';
import { useLiveTopic } from '@/lib/ws';
import { formatRef, timeAgo, formatTimestamp } from '@/lib/utils';
import type { Trade, TradeStatus } from '@/lib/types';

const PAGE_SIZE = 50;
const STATUSES = ['all', 'PENDING', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELED', 'FAILED'] as const;
const INTENTS = ['all', 'BUY', 'SELL'] as const;

function DetailRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

export function TradesPage(): React.JSX.Element {
  const client = useQueryClient();
  const [status, setStatus] = useState<string>('all');
  const [intent, setIntent] = useState<string>('all');
  const [selected, setSelected] = useState<Trade | null>(null);

  const query = useTrades({
    status: status === 'all' ? undefined : (status as TradeStatus),
    intent: intent === 'all' ? undefined : intent,
    limit: PAGE_SIZE,
    offset: 0,
  });

  const onLive = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['trades'] });
  }, [client]);
  useLiveTopic('trades', onLive);

  const trades = query.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((option) => (
              <SelectItem key={option} value={option}>
                {option === 'all' ? 'All statuses' : option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={intent} onValueChange={setIntent}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTENTS.map((option) => (
              <SelectItem key={option} value={option}>
                {option === 'all' ? 'All intents' : option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <TableSkeleton rows={6} cols={6} />
          ) : query.isError ? (
            <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
          ) : trades.length === 0 ? (
            <EmptyState
              icon={<ArrowLeftRight className="size-8" />}
              title="No trades yet"
              description="Trade offers appear here once the bot starts trading."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Partner</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Intent</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades.map((trade) => (
                  <TableRow key={trade.id} className="cursor-pointer" onClick={() => setSelected(trade)}>
                    <TableCell className="font-mono text-xs">{trade.partnerSteamId}</TableCell>
                    <TableCell className="font-medium">{trade.item.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{trade.intent}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">{formatRef(trade.priceRef)}</TableCell>
                    <TableCell>
                      <StatusBadge status={trade.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={formatTimestamp(trade.createdAt)}>
                      {timeAgo(trade.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent>
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle>{selected.item.name}</DialogTitle>
                <DialogDescription className="font-mono text-xs">{selected.item.skuKey}</DialogDescription>
              </DialogHeader>
              <div className="mt-2">
                <DetailRow label="Steam offer ID" value={<span className="font-mono">{selected.steamOfferId}</span>} />
                <DetailRow label="Partner" value={<span className="font-mono">{selected.partnerSteamId}</span>} />
                <DetailRow label="Intent" value={selected.intent} />
                <DetailRow label="Status" value={<StatusBadge status={selected.status} />} />
                <DetailRow label="Price" value={formatRef(selected.priceRef)} />
                <DetailRow label="Fair value" value={formatRef(selected.fairValueRef)} />
                <DetailRow
                  label="Profit"
                  value={selected.profitRef != null ? formatRef(selected.profitRef) : '—'}
                />
                <DetailRow label="Created" value={formatTimestamp(selected.createdAt)} />
                <DetailRow
                  label="Completed"
                  value={selected.completedAt ? formatTimestamp(selected.completedAt) : '—'}
                />
                {selected.errorMessage ? (
                  <DetailRow label="Error" value={<span className="text-destructive">{selected.errorMessage}</span>} />
                ) : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
