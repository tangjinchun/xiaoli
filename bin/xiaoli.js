#!/usr/bin/env node

// CLI 入口 — 转发到编译后的 main.js

const path = require('path');
const fs = require('fs');

const mainPath = path.join(__dirname, '..', 'dist', 'main.js');

if (!fs.existsSync(mainPath)) {
  console.error('xiaoli: 未找到编译产物，请先运行 npm run build');
  process.exit(1);
}

require(mainPath);
