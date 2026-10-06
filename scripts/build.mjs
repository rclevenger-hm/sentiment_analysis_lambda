import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await build({ entryPoints: ['lambda_function/handler.js', 'lambda_function/worker.js'], outdir: 'dist', bundle: true, platform: 'node', target: 'node24', format: 'cjs', minify: false, sourcemap: false, logLevel: 'info' });
