/**
 * 发布 GH Pages：重建 web 版 dist 并强制推送到 gh-pages 分支。
 * 首次需在仓库 Settings → Pages → Source 选 "Deploy from a branch" → gh-pages /(root)。
 * 用法: node scripts/deploy-pages.mjs
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TEMP = path.join(os.tmpdir(), 'mapvideo-ghp');

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

// 1. web 构建
run('npm run build', { cwd: ROOT });

// 2. 拷贝到临时目录并推送
fs.rmSync(TEMP, { recursive: true, force: true });
fs.mkdirSync(TEMP, { recursive: true });
fs.cpSync(path.join(ROOT, 'dist'), TEMP, { recursive: true });

const git = (args) => spawnSync('git', args, { cwd: TEMP, stdio: 'inherit', shell: process.platform === 'win32' });
run('git init -b gh-pages', { cwd: TEMP });
git(['add', '-A']);
git(['-c', 'user.name=map-video-deploy', '-c', 'user.email=deploy@users.noreply.github.com', 'commit', '-m', `deploy: web build ${new Date().toISOString()}`]);
git(['remote', 'add', 'origin', 'https://github.com/yluiop123/map-video.git']);
git(['push', 'origin', 'gh-pages', '--force']);
console.log('✓ gh-pages 已更新（Pages 若未开启，需在仓库设置里选 gh-pages /(root)）');
