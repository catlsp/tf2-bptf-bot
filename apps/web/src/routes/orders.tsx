import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { OrdersTable } from '@/components/orders-table';
import { Pagination } from '@/components/pagination';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { useDeleteOrder, useOrders } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useLiveTopic } from '@/lib/ws';
import type { OurListing } from '@/lib/types';

const PAGE_SIZE = 25;
const STATUS_OPTIONS = ['all', 'active', 'creating', 'deleting', 'failed', 'deleted'] as const;

export function OrdersPage(): React.JSX.Element {
  const client = useQueryClient();
  const [status, setStatus] = useState<string>('all');
  const [skuInput, setSkuInput] = useState('');
  const [offset, setOffset] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<OurListing | null>(null);

  const skuKey = useDebouncedValue(skuInput.trim());
  const query = useOrders({
    status: status === 'all' ? undefined : status,
    skuKey: skuKey || undefined,
    limit: PAGE_SIZE,
    offset,
  });
  const deleteOrder = useDeleteOrder();

  const onLive = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['orders'] });
  }, [client]);
  useLiveTopic('orders', onLive);

  const resetPaging = (next: () => void): void => {
    setOffset(0);
    next();
  };

  const confirmDelete = (): void => {
    if (!pendingDelete) return;
    const order = pendingDelete;
    deleteOrder.mutate(order.id, {
      onSuccess: () => {
        toast.success(`Order ${order.skuKey} flagged for deletion`);
        setPendingDelete(null);
      },
      onError: (error) => toast.error(error.message),
    });
  };

  const orders = query.data?.data ?? [];
  const total = query.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={skuInput}
            onChange={(event) => resetPaging(() => setSkuInput(event.target.value))}
            placeholder="Search SKU…"
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={(value) => resetPaging(() => setStatus(value))}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {option === 'all' ? 'All statuses' : option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <TableSkeleton rows={8} cols={7} />
          ) : query.isError ? (
            <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
          ) : orders.length === 0 ? (
            <EmptyState title="No orders match these filters" />
          ) : (
            <>
              <OrdersTable
                orders={orders}
                onDelete={setPendingDelete}
                deletingId={deleteOrder.isPending ? (pendingDelete?.id ?? null) : null}
              />
              <Pagination offset={offset} limit={PAGE_SIZE} total={total} onOffsetChange={setOffset} />
            </>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete this BUY order?"
        description={
          pendingDelete
            ? `${pendingDelete.skuKey} will be flagged status='deleting'. The bot removes it from backpack.tf on its next reconcile — it is not deleted from the database here.`
            : ''
        }
        confirmLabel="Delete order"
        destructive
        loading={deleteOrder.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
