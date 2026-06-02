// pm2 process definitions for VPS #2 (768 MB RAM, 1 CPU).
// Memory is the binding constraint, so both processes cap V8's old space and
// pm2 restarts them before they can OOM the box.
module.exports = {
  apps: [
    {
      name: 'bptf-bot',
      cwd: './apps/bot',
      script: 'src/server.ts',
      interpreter: 'node',
      node_args: '--import tsx --max-old-space-size=240',
      max_memory_restart: '270M',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,
      out_file: '/var/log/bptf/bot.out.log',
      error_file: '/var/log/bptf/bot.err.log',
      merge_logs: true,
      time: true,
    },
    {
      // Management-panel API. Runs via tsx from source like the bot. Loads its own
      // apps/api/.env (so it can point at the Neon pooler endpoint independently of
      // the bot). Bind stays on loopback — reach it over an SSH tunnel.
      name: 'bptf-api',
      cwd: './apps/api',
      script: 'src/index.ts',
      interpreter: 'node',
      node_args: '--import tsx --env-file=.env --max-old-space-size=200',
      max_memory_restart: '220M',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,
      out_file: '/var/log/bptf/api.out.log',
      error_file: '/var/log/bptf/api.err.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'bptf-telegram',
      cwd: './apps/telegram',
      script: 'src/bot.ts',
      interpreter: 'node',
      node_args: '--import tsx --max-old-space-size=120',
      max_memory_restart: '150M',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      out_file: '/var/log/bptf/telegram.out.log',
      error_file: '/var/log/bptf/telegram.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
