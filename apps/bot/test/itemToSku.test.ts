import { describe, it, expect } from 'vitest';
import { itemToSku, parseSku, isUnsupportedSku, baseItemName, econItemToSku } from '../src/util/itemToSku.js';

describe('isUnsupportedSku', () => {
  it('flags kits/fabricators/strangifiers (td/od/oq)', () => {
    expect(isUnsupportedSku('20003;6;kt-3;td-1099;od-6526;oq-6')).toBe(true);
    expect(isUnsupportedSku('6522;6;td-594')).toBe(true);
  });
  it('flags decorated war-paint items (wear + paintkit)', () => {
    expect(isUnsupportedSku('16390;15;w1;pk390')).toBe(true);
    expect(isUnsupportedSku('17407;15;w3;pk407')).toBe(true);
  });
  it('flags killstreak weapons, unusuals, australium, festive', () => {
    expect(isUnsupportedSku('172;3;kt-1')).toBe(true);
    expect(isUnsupportedSku('378;5;u13')).toBe(true);
    expect(isUnsupportedSku('205;11;australium')).toBe(true);
    expect(isUnsupportedSku('200;6;festive')).toBe(true);
  });
  it('passes plain items, strange items, and uncraftables', () => {
    expect(isUnsupportedSku('725;6')).toBe(false);
    expect(isUnsupportedSku('200;11')).toBe(false);
    expect(isUnsupportedSku('5976;6;uncraftable')).toBe(false);
  });
});

describe('baseItemName', () => {
  it('strips the Strange prefix for q11', () => {
    expect(baseItemName('Strange Lugermorph', 11, true)).toBe('Lugermorph');
  });
  it('strips Non-Craftable for uncraftables (then the quality prefix)', () => {
    expect(baseItemName('Non-Craftable Tour of Duty Ticket', 6, false)).toBe('Tour of Duty Ticket');
    expect(baseItemName('Non-Craftable Strange Pan', 11, false)).toBe('Pan');
  });
  it('does not strip quality words from q6 item names (Vintage Tyrolean is a real name)', () => {
    expect(baseItemName('Vintage Tyrolean', 6, true)).toBe('Vintage Tyrolean');
  });
  it('leaves already-base names untouched', () => {
    expect(baseItemName('Tour of Duty Ticket', 6, true)).toBe('Tour of Duty Ticket');
  });
});

describe('econItemToSku (incoming-offer matching)', () => {
  const econ = (over: Record<string, unknown> = {}) => ({
    market_hash_name: 'Tour of Duty Ticket',
    app_data: { def_index: '725', quality: '6' },
    descriptions: [] as Array<{ value?: string }>,
    ...over,
  });

  it('plain craftable item → defindex;quality', () => {
    expect(econItemToSku(econ())).toBe('725;6');
  });
  it('uncraftable variant gets its own SKU (never matches the craftable listing)', () => {
    expect(
      econItemToSku(econ({ descriptions: [{ value: '( Not Usable in Crafting )' }] })),
    ).toBe('725;6;uncraftable');
  });
  it('strange quality is preserved', () => {
    expect(econItemToSku(econ({ app_data: { def_index: '160', quality: '11' } }))).toBe('160;11');
  });
  it('killstreak / australium / festivized → null (unexpressible, never matches)', () => {
    expect(econItemToSku(econ({ market_hash_name: 'Killstreak Kukri' }))).toBeNull();
    expect(econItemToSku(econ({ market_hash_name: 'Strange Australium Rocket Launcher' }))).toBeNull();
    expect(econItemToSku(econ({ market_hash_name: 'Festivized Minigun' }))).toBeNull();
  });
  it('missing def_index → null', () => {
    expect(econItemToSku({ market_hash_name: 'X', app_data: {} })).toBeNull();
  });
});

describe('existing itemToSku/parseSku still behave', () => {
  it('round-trips a plain sku', () => {
    expect(itemToSku({ defindex: 725, quality: 6 })).toBe('725;6');
    expect(parseSku('725;6')).toEqual({ defindex: 725, quality: 6, craftable: true });
  });
});
