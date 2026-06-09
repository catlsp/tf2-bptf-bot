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
import { useUpsertWatchlist } from '@/lib/queries';
import type { UpsertWatchlistInput, WatchlistRow } from '@/lib/types';

interface FormState {
  skuKey: string;
  maxBuyRef: string;
  minSellRef: string;
  maxQty: string;
  notes: string;
}

function toForm(row?: WatchlistRow): FormState {
  return {
    skuKey: row?.skuKey ?? '',
    maxBuyRef: row?.maxBuyRef != null ? String(row.maxBuyRef) : '',
    minSellRef: row?.minSellRef != null ? String(row.minSellRef) : '',
    maxQty: row?.maxQty != null ? String(row.maxQty) : '',
    notes: row?.notes ?? '',
  };
}

export function WatchlistEditor({
  open,
  onOpenChange,
  row,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row?: WatchlistRow;
}): React.JSX.Element {
  const isEdit = row !== undefined;
  const [form, setForm] = useState<FormState>(() => toForm(row));
  const [error, setError] = useState<string | null>(null);

  const upsert = useUpsertWatchlist();

  useEffect(() => {
    if (open) {
      setForm(toForm(row));
      setError(null);
    }
  }, [open, row]);

  const set = (key: keyof FormState, value: string): void =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const parsePositive = (raw: string): number | null => {
    const value = Number(raw);
    return raw.trim() !== '' && Number.isFinite(value) && value > 0 ? value : null;
  };

  const handleSubmit = (): void => {
    setError(null);
    const skuKey = form.skuKey.trim();
    if (skuKey === '') {
      setError('SKU key is required.');
      return;
    }
    // All caps are optional. Empty = "no per-SKU override for this field".
    let maxBuyRef: number | undefined;
    if (form.maxBuyRef.trim() !== '') {
      const v = parsePositive(form.maxBuyRef);
      if (v === null) {
        setError('Max buy (ref) must be a positive number.');
        return;
      }
      maxBuyRef = v;
    }
    let minSellRef: number | null | undefined;
    if (form.minSellRef.trim() !== '') {
      const v = parsePositive(form.minSellRef);
      if (v === null) {
        setError('Min sell (ref) must be a positive number.');
        return;
      }
      minSellRef = v;
    }
    let maxQty: number | null | undefined;
    if (form.maxQty.trim() !== '') {
      const v = parsePositive(form.maxQty);
      if (v === null || !Number.isInteger(v)) {
        setError('Max qty must be a positive whole number.');
        return;
      }
      maxQty = v;
    }
    const notes = form.notes.trim() === '' ? null : form.notes.trim();

    const input: UpsertWatchlistInput = { skuKey, maxBuyRef, minSellRef, maxQty, notes };
    upsert.mutate(input, {
      onSuccess: () => {
        toast.success(`Saved ${skuKey}`);
        onOpenChange(false);
      },
      onError: (e) => setError(e.message),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${row.name ?? row.skuKey}` : 'Add SKU override'}</DialogTitle>
          <DialogDescription>
            Per-SKU controls for the bot. Leave a field blank to use the default (pricedb rail /
            global cap). SKU format is <code className="text-xs">defindex;quality;…</code>.
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
                placeholder="no cap"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="minSellRef">Min sell (ref)</Label>
              <Input
                id="minSellRef"
                inputMode="decimal"
                value={form.minSellRef}
                onChange={(event) => set('minSellRef', event.target.value)}
                placeholder="no floor"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="maxQty">Max qty (how many to hold)</Label>
              <Input
                id="maxQty"
                inputMode="numeric"
                value={form.maxQty}
                onChange={(event) => set('maxQty', event.target.value)}
                placeholder="global default"
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={upsert.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={upsert.isPending}>
            {upsert.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
