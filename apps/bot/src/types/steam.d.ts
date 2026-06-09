// The steam-* packages ship no type declarations. We use them through thin
// wrappers in integrations/steam.ts, so declaring them as `any`-typed modules is
// sufficient and keeps the rest of the codebase strict.
declare module 'steam-user';
declare module 'steam-totp';
declare module 'steamcommunity';
declare module 'steam-tradeoffer-manager';
declare module 'tf2';
