import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['main.ts'], outfile: 'dist/main.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', packages: 'external',
  alias: { '@': path.resolve('../../woek-parlament-app') },
});
await copyFile('../../assets/js/newsletter.js', 'dist/client.js');
