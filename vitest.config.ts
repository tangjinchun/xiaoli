import { defineConfig } from 'vitest/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 源码使用 Node16 的 .js 后缀导入 TS 文件。
 * Vite 默认不会把 ./foo.js 映射到 ./foo.ts，这里补一个解析插件。
 */
export default defineConfig({
  plugins: [
    {
      name: 'resolve-ts-from-js',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer || !source.endsWith('.js')) return null;
        const candidate = path.resolve(
          path.dirname(importer),
          source.replace(/\.js$/, '.ts'),
        );
        return fs.existsSync(candidate) ? candidate : null;
      },
    },
  ],
  test: {
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // 测试会修改 XIAOLI_HOME；串行执行避免不同测试文件互相污染数据目录。
    fileParallelism: false,
  },
});
