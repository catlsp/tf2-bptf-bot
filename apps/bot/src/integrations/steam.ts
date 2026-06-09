import SteamUser from 'steam-user';
import SteamTotp from 'steam-totp';
import SteamCommunity from 'steamcommunity';
import TradeOfferManager from 'steam-tradeoffer-manager';
import TeamFortress2 from 'tf2';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';
import { sleep, DEFINDEX, metalToRef } from '../lib/utils.js';

// Steam wrapper. Mirrors tf2vault bot.js: logOn with a TOTP code, refresh the
// web session every 15 min, rebuild the TradeOfferManager cookies on webSession,
// re-login on error with eresult-aware backoff. Idles in TF2 and keeps a Game
// Coordinator session so it can sort the backpack (which also nudges bp.tf to
// re-read the inventory). Real accepts are mobile-confirmed with the identity
// secret.

const client = new SteamUser();
const community = new SteamCommunity();
const manager = new TradeOfferManager({
  steam: client,
  community,
  language: 'en',
  cancelTime: 5 * 60 * 1000,
});
// TF2 Game Coordinator client — connects automatically once we're "playing" 440.
const tf2 = new TeamFortress2(client);

export { client, community, manager };

let ready = false;
export function isSteamReady(): boolean {
  return ready;
}

let gcReady = false;
tf2.on('connectedToGC', () => {
  gcReady = true;
  logger.info('TF2 game coordinator connected');
});
tf2.on('disconnectedFromGC', () => {
  gcReady = false;
  logger.warn('TF2 game coordinator disconnected');
});

export function isGcReady(): boolean {
  return gcReady;
}

/**
 * Ask the GC to sort the backpack (default: by quality). Sorting writes to the
 * backpack, which prompts bp.tf to re-read our inventory — so listings reflect
 * what we actually hold. No-op until the GC session is up.
 */
export function sortBackpack(): void {
  if (!gcReady) {
    logger.warn('skip sortBackpack: GC not ready');
    return;
  }
  try {
    tf2.sortBackpack(env.TF2_SORT_TYPE);
    logger.info({ sortType: env.TF2_SORT_TYPE }, 'requested backpack sort');
  } catch (e) {
    logger.warn({ err: errMessage(e) }, 'sortBackpack failed');
  }
}

/**
 * Leave TF2 and rejoin a few seconds later. The rejoin re-establishes the GC
 * session and refreshes our online/in-game state, which (together with a sort)
 * gets bp.tf to pick up inventory changes after a trade.
 */
export async function relogGame(): Promise<void> {
  try {
    client.gamesPlayed([]);
    await sleep(3000);
    client.gamesPlayed([440]);
    logger.info('rejoined TF2');
  } catch (e) {
    logger.warn({ err: errMessage(e) }, 'relogGame failed');
  }
}

/**
 * Mobile-confirm a trade offer with the account's identity secret. Any accept
 * where we give items (metal on a buy, the item on a sell) needs this or the
 * trade never completes. Safe to call even when no confirmation is pending.
 */
export function confirmOffer(offerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    community.acceptConfirmationForObject(
      env.STEAM_IDENTITY_SECRET,
      offerId,
      (err: Error | null) => (err ? reject(err) : resolve()),
    );
  });
}

function buildLogOnOptions() {
  return {
    accountName: env.STEAM_ACCOUNT_NAME,
    password: env.STEAM_PASSWORD,
    twoFactorCode: SteamTotp.generateAuthCode(env.STEAM_SHARED_SECRET),
    rememberPassword: true,
  };
}

/** Resolves once the TradeOfferManager has valid cookies (web session up). */
export function startSteam(): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    client.logOn(buildLogOnOptions());

    // keep the web session warm — same cadence as bot.js
    setInterval(() => {
      if (client.steamID) {
        logger.debug('refreshing steam web session');
        client.webLogOn();
      }
    }, 15 * 60 * 1000);

    client.on('loggedOn', () => {
      logger.info({ steamId: client.steamID?.getSteamID64() }, 'logged into steam');
      client.setPersona(SteamUser.EPersonaState.Online);
      client.gamesPlayed([440]); // idle in TF2
    });

    client.on('webSession', (_sessionId: string, cookies: string[]) => {
      manager.setCookies(cookies, (err: Error | null) => {
        if (err) {
          logger.error({ err: err.message }, 'failed to set trade manager cookies');
          if (!settled) {
            settled = true;
            reject(err);
          }
          return;
        }
        community.setCookies(cookies);
        ready = true;
        logger.info('trade offer manager ready (idle, paper mode)');
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      // identity secret wired up but only consumed when we confirm offers (Phase 3+)
      community.setCookies(cookies);
    });

    client.on('error', (err: Error & { eresult?: number }) => {
      ready = false;
      const delayMs = err.eresult === 84 ? 5 * 60 * 1000 : 15 * 1000;
      logger.error({ err: err.message, eresult: err.eresult }, `steam error, re-login in ${Math.round(delayMs / 1000)}s`);
      setTimeout(() => client.logOn(buildLogOnOptions()), delayMs);
    });
  });
}

export interface RawInvItem {
  assetid: string;
  market_hash_name?: string;
  name?: string;
  // steam-tradeoffer-manager attaches a tradable flag and app data
  tradable?: boolean;
}

/** Load the bot's own TF2 inventory (appid 440, context 2). */
export function loadInventory(): Promise<RawInvItem[]> {
  return new Promise((resolve, reject) => {
    manager.getInventoryContents(440, 2, true, (err: Error | null, items: RawInvItem[]) => {
      if (err) return reject(err);
      logger.debug({ count: items?.length ?? 0 }, 'loaded bot inventory');
      resolve(items ?? []);
    });
  });
}

export interface MetalCounts {
  keys: number;
  refined: number;
  reclaimed: number;
  scrap: number;
  refinedTotal: number;
}

/** Count keys + metal from a raw inventory, exactly as bot.js's syncBotStock does. */
export function countMetal(items: RawInvItem[]): MetalCounts {
  let keys = 0;
  let refined = 0;
  let reclaimed = 0;
  let scrap = 0;
  for (const it of items) {
    const name = it.market_hash_name || it.name || '';
    if (name === 'Mann Co. Supply Crate Key') keys++;
    else if (name === 'Refined Metal') refined++;
    else if (name === 'Reclaimed Metal') reclaimed++;
    else if (name === 'Scrap Metal') scrap++;
  }
  return { keys, refined, reclaimed, scrap, refinedTotal: metalToRef(refined, reclaimed, scrap) };
}

/** Count how many of a defindex are present (keys etc.). */
export function countDefindex(counts: MetalCounts, defindex: number): number {
  if (defindex === DEFINDEX.KEY) return counts.keys;
  if (defindex === DEFINDEX.REFINED) return counts.refined;
  if (defindex === DEFINDEX.RECLAIMED) return counts.reclaimed;
  if (defindex === DEFINDEX.SCRAP) return counts.scrap;
  return 0;
}

export async function safeLoadMetal(): Promise<MetalCounts> {
  try {
    return countMetal(await loadInventory());
  } catch (e) {
    logger.warn({ err: errMessage(e) }, 'inventory load failed; returning zeros');
    return { keys: 0, refined: 0, reclaimed: 0, scrap: 0, refinedTotal: 0 };
  }
}
