// pm2 process definition. Start with:  pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'lead-generator',
      script: 'src/server.js',
      cwd: __dirname, // .env is read from here
      instances: 1, // must stay 1: one process owns the Sheet writes and the batch lock
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      kill_timeout: 15000, // lets the server flush pending Sheet writes on shutdown
      time: true, // timestamps in logs
      env: { NODE_ENV: 'production' },
    },
  ],
};
