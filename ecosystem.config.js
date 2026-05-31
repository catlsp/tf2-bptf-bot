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
