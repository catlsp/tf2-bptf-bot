import { Trash2 } from 'lucide-react';
import type { OurListing } from '@/lib/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/status-badge';
import { formatRef, timeAgo, formatTimestamp } from '@/lib/utils';

function priceHint(order: OurListing): string {
  if (order.priceKeys > 0) return `${order.priceKeys} key + ${order.priceMetal} ref`;
  return `${order.priceMetal} ref`;
}

export function OrdersTable({
  orders,
  onDelete,
  deletingId,
}: {
  orders: OurListing[];
  onDelete: (order: OurListing) => void;
  deletingId: string | null;
}): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>SKU</TableHead>
          <TableHead>Intent</TableHead>
          <TableHead>Price</TableHead>
          <TableHead>Fair value</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Refreshed</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => {
          const closed = order.status === 'deleting' || order.status === 'deleted';
          return (
            <TableRow key={order.id}>
              <TableCell className="font-mono text-xs">{order.skuKey}</TableCell>
              <TableCell>
                <Badge variant="outline" className="uppercase">
                  {order.intent}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="font-medium tabular-nums">{formatRef(order.priceRef)}</div>
                <div className="text-xs text-muted-foreground">{priceHint(order)}</div>
              </TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                {formatRef(order.fairValueRef)}
              </TableCell>
              <TableCell>
                <StatusBadge status={order.status} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground" title={formatTimestamp(order.refreshedAt)}>
                {timeAgo(order.refreshedAt)}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={closed || deletingId === order.id}
                  onClick={() => onDelete(order)}
                  aria-label="Delete order"
                >
                  <Trash2 className="size-4" />
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
