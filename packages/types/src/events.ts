// Event union published over Redis pub/sub. Consumed by Telegram (Phase 1)
// and the dashboard WebSocket bridge (Phase 9).

import type { Balance, TradeDecision } from './trading.js';

export const BOT_EVENTS_CHANNEL = 'bot:events';
export const BOT_CONFIG_CHANNEL = 'bot:config:updated';

export type BotEventLevel = 'info' | 'warn' | 'error';

interface BaseEvent {
  level: BotEventLevel;
  at: string; // ISO timestamp
}

export interface ScanCompletedEvent extends BaseEvent {
  type: 'scan.completed';
  skusScanned: number;
  opportunities: number;
  durationMs: number;
}

export interface PaperTradeEvent extends BaseEvent {
  type: 'paper.trade';
  decision: TradeDecision;
}

export interface BalanceEvent extends BaseEvent {
  type: 'balance.summary';
  balance: Balance;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  scope: string;
  message: string;
}

export interface EmergencyStopEvent extends BaseEvent {
  type: 'emergency.stop';
  active: boolean;
  reason: string;
}

export type BotEvent =
  | ScanCompletedEvent
  | PaperTradeEvent
  | BalanceEvent
  | ErrorEvent
  | EmergencyStopEvent;
