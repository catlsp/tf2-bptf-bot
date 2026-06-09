import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, RotateCcw, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { WatchlistEditor } from '@/components/watchlist-editor';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { useDeleteWatchlist, useUpsertWatchlist, useWatchlist } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { formatRef } from '@/lib/utils';
import type { WatchlistRow } from '@/lib/types';

export function WatchlistPage(): React.JSX.Element {
  const query = useWatchlist();
  const upsert = useUpsertWatchlist();
  const remove = useDeleteWatchlist();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<WatchlistRow | undefined>(undefined);
  const [pendingClear, setPendingClear] = useState<WatchlistRow | null>(null);
  const [togglingSku, setTogglingSku] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const term = useDebouncedValue(search.trim().toLowerCase());

  const openCreate = (): void => {
    setEditing(undefined);
    setEditorOpen(true);
  };
  const openEdit = (row: WatchlistRow): void => {
    setEditing(row);
    setEditorOpen(true);
  };

  const toggleActive = (row: WatchlistRow, active: boolean): void => {
    setTogglingSku(row.skuKey);
    upsert.mutate(
      { skuKey: row.skuKey, active },
      {
        onSuccess: () => toast.success(`${row.name ?? row.skuKey} ${active ? 'enabled' : 'paused'}`),
        onError: (error) => toast.error(error.message),
        onSettled: () => setTogglingSku(null),
      },
    );
  };

  const confirmClear = (): void => {
    if (!pendingClear?.entryId) return;
    const row = pendingClear;
    remove.mutate(row.entryId!, {
      onSuccess: () => {
        toast.success(`Reset ${row.name ?? row.skuKey} to defaults`);
        setPendingClear(null);
      },
      onError: (error) => toast.error(error.message),
    });
  };

  const rows = useMemo(() => {
    const all = query.data ?? [];
    if (term === '') return all;
    return all.filter(
      (r) => r.skuKey.toLowerCase().includes(term) || (r.name ?? '').toLowerCase().includes(term),
    );
  }, [query.data, term]);

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
        <span className="text-xs text-muted-foreground sm:ml-auto">{rows.length} tracked</span>
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          Add SKU
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <TableSkeleton rows={10} cols={7} />
          ) : query.isError ? (
            <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="Nothing tracked yet"
              description="The bot records SKUs as it scans; they appear here within a minute or two."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Buy</TableHead>
                  <TableHead className="text-right">Sell</TableHead>
                  <TableHead className="text-right">Position</TableHead>
                  <TableHead className="text-right">Max buy</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.skuKey} className={row.active ? '' : 'opacity-50'}>
                    <TableCell>
                      <div className="font-medium">{row.name ?? '—'}</div>
                      <div className="font-mono text-xs text-muted-foreground">{row.skuKey}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.refBuyRef != null ? formatRef(row.refBuyRef) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.refSellRef != null ? formatRef(row.refSellRef) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.held}/{row.maxQty ?? '∞'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {row.maxBuyRef != null ? formatRef(row.maxBuyRef) : '—'}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={row.active}
                        disabled={togglingSku === row.skuKey}
                        onCheckedChange={(checked) => toggleActive(row, checked)}
                        aria-label="Toggle active"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => openEdit(row)}
                          aria-label="Edit overrides"
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                          onClick={() => setPendingClear(row)}
                          disabled={!row.entryId}
                          aria-label="Reset to defaults"
                          title={row.entryId ? 'Reset to defaults' : 'No override set'}
                        >
                          <RotateCcw className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <WatchlistEditor open={editorOpen} onOpenChange={setEditorOpen} row={editing} />

      <ConfirmDialog
        open={pendingClear !== null}
        onOpenChange={(open) => {
          if (!open) setPendingClear(null);
        }}
        title="Reset to defaults?"
        description={
          pendingClear
            ? `${pendingClear.name ?? pendingClear.skuKey} will lose its per-SKU override and use global defaults.`
            : ''
        }
        confirmLabel="Reset"
        loading={remove.isPending}
        onConfirm={confirmClear}
      />
    </div>
  );
}
