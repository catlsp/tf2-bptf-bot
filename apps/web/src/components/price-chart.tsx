import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PriceSnapshot } from '@/lib/types';

export function PriceChart({ snapshots }: { snapshots: PriceSnapshot[] }): React.JSX.Element {
  const data = snapshots.map((snapshot) => ({
    t: new Date(snapshot.capturedAt).getTime(),
    buyRef: snapshot.buyRef,
    sellRef: snapshot.sellRef,
  }));

  const formatTick = (value: number): string => {
    const date = new Date(value);
    return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(
      date.getHours(),
    ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 16, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatTick}
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
          />
          <YAxis
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(value: number) => `${value}`}
          />
          <Tooltip
            labelFormatter={(value: number) => formatTick(value)}
            formatter={(value: number, name: string) => [`${value} ref`, name === 'buyRef' ? 'Buy' : 'Sell']}
            contentStyle={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: 'hsl(var(--foreground))' }}
          />
          <Legend
            formatter={(value: string) => (value === 'buyRef' ? 'Buy' : 'Sell')}
            wrapperStyle={{ fontSize: 12 }}
          />
          <Line
            type="monotone"
            dataKey="buyRef"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="sellRef"
            stroke="hsl(var(--success))"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
