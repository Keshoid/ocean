// Bundles src/ into a single self-contained index.html.  `node build.mjs --dev` keeps the code readable.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const dev = process.argv.includes('--dev');
const out = await build({
  entryPoints: ['src/main.js'], bundle: true, format: 'iife', minify: !dev, write: false, target: 'es2022', legalComments: 'none',
});
const js = out.outputFiles[0].text;
const html = readFileSync('template.html', 'utf8').replace('/*JS*/', () => js);
writeFileSync('index.html', html);
console.log(`index.html  ${(html.length / 1024).toFixed(1)} KB`);
