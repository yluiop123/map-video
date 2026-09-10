/**
 * 桌面端开发模式：同时拉起 vite(5173) 与 Electron 主进程（渲染走 vite 热更）。
 * Ctrl+C 一并退出。用法: npm run electron:dev
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const isWin = process.platform === 'win32';

const children = [];

function waitVite(retries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      http.get('http://localhost:5173/', () => resolve(true)).on('error', () => {
        if (n <= 0) return reject(new Error('vite 启动超时'));
        setTimeout(() => tick(n - 1), 500);
      });
    };
    tick(retries);
  });
}

function cleanup() {
  for (const c of children) {
    try { c.kill(); } catch { /* ignore */ }
  }
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// 1. vite（前端热更）
// 注意：Node 20.12+/22 在 Windows 下 spawn .cmd 必须经 shell，否则抛 EINVAL
const vite = spawn(isWin ? 'npm.cmd' : 'npm', ['run', 'dev'], {
  stdio: 'inherit',
  shell: isWin,
});
children.push(vite);

await waitVite();

// 2. Electron（渲染进程加载 vite；保留默认 electron 用户数据目录以便真机一致性）
// 直接起 electron.exe（由 electron 包导出的真实二进制路径），避免 .cmd + EINVAL
const electronBin = require('electron');
const electron = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RENDERER_URL: 'http://localhost:5173/map-video/',
    ELECTRON_ENABLE_LOGGING: '1',
  },
});
children.push(electron);
electron.on('exit', cleanup);
