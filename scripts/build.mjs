import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/worker.js'],outfile:'dist/worker.mjs',bundle:true,format:'esm',platform:'browser',target:'es2022',
  conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],loader:{'.html':'text','.css':'text','.txt':'text'},minify:true,legalComments:'eof'});
await writeFile('dist/README.txt','worker.mjs — собранный модуль. Для развёртывания всё равно нужны Browser binding BROWSER, Durable Object PANEL / PollPanel, миграция v1 и секреты. Предпочтительный способ: wrangler.jsonc и npm run deploy.\n');
console.log('Собрано: dist/worker.mjs');
