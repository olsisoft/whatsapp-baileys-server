module.exports = {
  apps: [{
    name: 'whatsapp-server',
    script: 'src/index.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    },
    // Gestion des logs
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/dev/stderr',
    out_file: '/dev/stdout',
    merge_logs: true,
    // Redemarrage automatique
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000
  }]
};
