import { useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { WatchlistEditor } from '@/components/watchlist-editor';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { useDeleteWatchlist, useUpdateWatchlist, useWatchlist } from '@/lib/queries';
import { formatRef } from '@/lib/utils';
import type { WatchlistEntry } from '@/lib/types';

export function WatchlistPage(): React.JSX.Element {
  const query = useWatchlist();
  const update = useUpdateWatchlist();
  const remove = useDeleteWatchlist();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<WatchlistEntry | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<WatchlistEntry | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const openCreate = (): void => {
    setEditing(undefined);
    setEditorOpen(true);
  };
  const openEdit = (entry: WatchlistEntry): void => {
    setEditing(entry);
    setEditorOpen(true);
  };

  const toggleActive = (entry: WatchlistEntry, active: boolean): void => {
    setTogglingId(entry.id);
    update.mutate(
      { id: entry.id, input: { active } },
      {
        onSuccess: () => toast.success(`${entry.skuKey} ${active ? 'enabled' : 'paused'}`),
        onError: (error) => toast.error(error.message),
        onSettled: () => setTogglingId(null),
      },
    );
  };

  const confirmDelete = (): void => {
    if (!pendingDelete) return;
    const entry = pendingDelete;
    remove.mutate(entry.id, {
      onSuccess: () => {
        toast.success(`Removed ${entry.skuKey}`);
        setPendingDelete(null);
      },
      onError: (error) => toast.error(error.message),
    });
  };

  const entries = query.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          Add SKU
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <TableSkeleton rows={8} cols={6} />
          ) : query.isError ? (
            <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
          ) : entries.length === 0 ? (
            <EmptyState
              title="Watchlist is empty"
              description="Add a SKU to tell the bot what to bid on."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Max buy</TableHead>
                  <TableHead>Min sell</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-mono text-xs">{entry.skuKey}</TableCell>
                    <TableCell className="tabular-nums">{formatRef(entry.maxBuyRef)}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {entry.minSellRef != null ? formatRef(entry.minSellRef) : '—'}
                    </TableCell>
                    <TableCell className="tabular-nums">{entry.priority}</TableCell>
                    <TableCell className="max-w-[16rem] truncate text-muted-foreground">
                      {entry.notes ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={entry.active}
                        disabled={togglingId === entry.id}
                        onCheckedChange={(checked) => toggleActive(entry, checked)}
                        aria-label="Toggle active"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => openEdit(entry)}
                          aria-label="Edit entry"
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setPendingDelete(entry)}
                          aria-label="Delete entry"
                        >
                          <Trash2 className="size-4" />
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

      <WatchlistEditor open={editorOpen} onOpenChange={setEditorOpen} entry={editing} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Remove from watchlist?"
        description={pendingDelete ? `${pendingDelete.skuKey} will be permanently removed.` : ''}
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
