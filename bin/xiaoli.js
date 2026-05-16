#!/usr/bin/env node

// CLI 入口 — 转发到编译后的 main.js
// 支持两种运行方式：
//   1. npm link 开发模式 → 直接加载 dist/main.js
//   2. npm install -g 全局安装 → bin 指向此文件

const path = require('path');
const fs = require('fs');

// 开发模式：dist 在项目根目录
const devPath = path.join(__dirname, '..', 'dist', 'main.js');
// 全局安装模式：dist 在包目录
const globalPath = path.join(__dirname, '..', 'dist', 'main.js');

const mainPath = fs.existsSync(devPath) ? devPath : globalPath;

if (!fs.existsSync(mainPath)) {
  console.error('xiaoli: 未找到编译产物，请先运行 npm run build');
  process.exit(1);
}

require(mainPath);
