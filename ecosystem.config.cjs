const path = require('path');

const repoDir = __dirname;

module.exports = {
  apps: [
    {
      name: 'hailo-back',
      script: path.join(repoDir, 'server.js'),
      cwd: repoDir,
      exec_mode: 'fork',
      env: {
        PORT: 3000,
        // 로컬/기본 업로드 경로
        UPLOAD_DIR: path.join(repoDir, 'uploads'),
        DATA_DIR: path.join(repoDir, 'data'),
      },
      env_production: {
        NODE_ENV: 'production',
        // 라즈베리 파이에서 원래 경로를 쓰고 싶다면 아래 경로를 유지하세요.
        UPLOAD_DIR: '/home/ray/uploads',
        DATA_DIR: '/home/ray/data',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
    },
  ],
};
