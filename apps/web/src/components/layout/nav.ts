import {
  ArrowLeftRight,
  Boxes,
  Eye,
  LayoutDashboard,
  ListOrdered,
  ScrollText,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Exact match (only the index route) vs prefix match. */
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/orders', label: 'Orders', icon: ListOrdered },
  { to: '/watchlist', label: 'Watchlist', icon: Eye },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/inventory', label: 'Inventory', icon: Boxes },
  { to: '/trades', label: 'Trades', icon: ArrowLeftRight },
  { to: '/prices', label: 'Prices', icon: TrendingUp },
];

export function titleForPath(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  const match = NAV_ITEMS.find((item) => item.to !== '/' && pathname.startsWith(item.to));
  return match?.label ?? 'Panel';
}
