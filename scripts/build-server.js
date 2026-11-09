/**
 * 跨平台构建脚本：把服务端打成单文件 dist/server.mjs。
 *
 * 之前直接在 package.json 里写 --banner:js='...'，
 * 在 Windows（cmd/PowerShell）下单引号不会被剥离，esbuild 会把它当成多个输入文件。
 * 放到 JS 里调用可避免 shell 引号差异。
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: {
    js: 'import{createRequire} from"node:module";const require=createRequire(import.meta.url);',
  },
  outfile: 'dist/server.mjs',
});
