import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/layout/app-layout';
import { DashboardPage } from './routes/dashboard';
import { OrdersPage } from './routes/orders';
import { WatchlistPage } from './routes/watchlist';
import { LogsPage } from './routes/logs';
import { InventoryPage } from './routes/inventory';
import { TradesPage } from './routes/trades';
import { MarketPage } from './routes/market';
import { PricesPage } from './routes/prices';

export function App(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="watchlist" element={<WatchlistPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="trades" element={<TradesPage />} />
        <Route path="market" element={<MarketPage />} />
        <Route path="prices" element={<PricesPage />} />
        <Route path="prices/:skuKey" element={<PricesPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
