import { Badge, type BadgeProps } from '@/components/ui/badge';

type Variant = NonNullable<BadgeProps['variant']>;

// Maps the various status strings the bot writes onto badge variants. Anything
// unrecognised falls back to a neutral badge rather than throwing.
const STATUS_VARIANTS: Record<string, Variant> = {
  // OurListing
  active: 'success',
  creating: 'warning',
  deleting: 'warning',
  deleted: 'secondary',
  failed: 'destructive',
  // Trade
  ACCEPTED: 'success',
  PENDING: 'warning',
  SENT: 'warning',
  DECLINED: 'secondary',
  EXPIRED: 'secondary',
  CANCELED: 'secondary',
  FAILED: 'destructive',
  // InventoryItem
  HELD: 'default',
  LISTED: 'success',
  RESERVED: 'warning',
  SOLD: 'secondary',
  // EventLog level
  info: 'secondary',
  warn: 'warning',
  error: 'destructive',
};

export function StatusBadge({ status }: { status: string }): React.JSX.Element {
  return <Badge variant={STATUS_VARIANTS[status] ?? 'outline'}>{status}</Badge>;
}
