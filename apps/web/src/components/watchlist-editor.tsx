import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateWatchlist, useUpdateWatchlist } from '@/lib/queries';
import { ApiError } from '@/lib/api';
import type { CreateWatchlistInput, UpdateWatchlistInput, WatchlistEntry } from '@/lib/types';

interface FormState {
  skuKey: string;
  maxBuyRef: string;
  minSellRef: string;
  priority: string;
  notes: string;
}

function toForm(entry?: WatchlistEntry): FormState {
  return {
    skuKey: entry?.skuKey ?? '',
    maxBuyRef: entry ? String(entry.maxBuyRef) : '',
    minSellRef: entry?.minSellRef != null ? String(entry.minSellRef) : '',
    priority: entry ? String(entry.priority) : '0',
    notes: entry?.notes ?? '',
  };
}

export function WatchlistEditor({
  open,
  onOpenChange,
  entry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry?: WatchlistEntry;
}): React.JSX.Element {
  const isEdit = entry !== undefined;
  const [form, setForm] = useState<FormState>(() => toForm(entry));
  const [error, setError] = useState<string | null>(null);

  const create = useCreateWatchlist();
  const update = useUpdateWatchlist();
  const pending = create.isPending || update.isPending;

  // Reset the form whenever the dialog opens for a (possibly different) entry.
  useEffect(() => {
    if (open) {
      setForm(toForm(entry));
      setError(null);
    }
  }, [open, entry]);

  const set = (key: keyof FormState, value: string): void =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const parseRef = (raw: string): number | null => {
    const value = Number(raw);
    return raw.trim() !== '' && Number.isFinite(value) && value > 0 ? value : null;
  };

  const handleSubmit = (): void => {
    setError(null);
    const maxBuyRef = parseRef(form.maxBuyRef);
    if (!isEdit && form.skuKey.trim() === '') {
      setError('SKU key is required.');
      return;
    }
    if (maxBuyRef === null) {
      setError('Max buy (ref) must be a positive number.');
      return;
    }
    const minSellRef = form.minSellRef.trim() === '' ? null : parseRef(form.minSellRef);
    if (form.minSellRef.trim() !== '' && minSellRef === null) {
      setError('Min sell (ref) must be a positive number.');
      return;
    }
    const priority = Number(form.priority);
    if (!Number.isInteger(priority)) {
      setError('Priority must be a whole number.');
      return;
    }
    const notes = form.notes.trim() === '' ? null : form.notes.trim();

    const onError = (mutationError: Error): void => {
      const message =
        mutationError instanceof ApiError && mutationError.status === 409
          ? 'A watchlist entry with this SKU already exists.'
          : mutationError.message;
      setError(message);
    };

    if (isEdit) {
      const input: UpdateWatchlistInput = { maxBuyRef, minSellRef, priority, notes };
      update.mutate(
        { id: entry.id, input },
        {
          onSuccess: () => {
            toast.success(`Updated ${entry.skuKey}`);
            onOpenChange(false);
          },
          onError,
        },
      );
    } else {
      const input: CreateWatchlistInput = { skuKey: form.skuKey.trim(), maxBuyRef, minSellRef, priority, notes };
      create.mutate(input, {
        onSuccess: (created) => {
          toast.success(`Added ${created.skuKey} to watchlist`);
          onOpenChange(false);
        },
        onError,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${entry.skuKey}` : 'Add SKU to watchlist'}</DialogTitle>
          <DialogDescription>
            Watchlist entries drive what the bot bids on. SKU key format is{' '}
            <code className="text-xs">defindex;quality;…</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="skuKey">SKU key</Label>
            <Input
              id="skuKey"
              value={form.skuKey}
              onChange={(event) => set('skuKey', event.target.value)}
              placeholder="5021;6"
              disabled={isEdit}
              className="font-mono"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="maxBuyRef">Max buy (ref)</Label>
              <Input
                id="maxBuyRef"
                inputMode="decimal"
                value={form.maxBuyRef}
                onChange={(event) => set('maxBuyRef', event.target.value)}
                placeholder="62.5"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="minSellRef">Min sell (ref)</Label>
              <Input
                id="minSellRef"
                inputMode="decimal"
                value={form.minSellRef}
                onChange={(event) => set('minSellRef', event.target.value)}
                placeholder="optional"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="priority">Priority</Label>
              <Input
                id="priority"
                inputMode="numeric"
                value={form.priority}
                onChange={(event) => set('priority', event.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Input
                id="notes"
                value={form.notes}
                onChange={(event) => set('notes', event.target.value)}
                placeholder="optional"
              />
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {isEdit ? 'Save changes' : 'Add SKU'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
