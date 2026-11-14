// Construit le frontend : bundle React (esbuild) + copie des fichiers statiques vers web/dist.
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'web/dist');
let esbuild;
try { esbuild = await import('esbuild'); } catch { esbuild = createRequire('/opt/npm-tools/node_modules/')('esbuild'); }

rmSync(dist, { recursive: true, force: true });
mkdirSync(resolve(dist, 'assets'), { recursive: true });
await esbuild.build({
  entryPoints: [resolve(root, 'web/src/main.tsx')], bundle: true, format: 'esm', target: 'es2020', minify: true, sourcemap: false,
  outfile: resolve(dist, 'assets/app.js'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: ['/home/claude/.npm-global/lib/node_modules', '/opt/npm-tools/node_modules'].filter(existsSync), logLevel: 'warning',
});
await esbuild.build({ entryPoints: [resolve(root, 'web/src/styles.css')], bundle: true, minify: true, outfile: resolve(dist, 'assets/app.css'), logLevel: 'warning' });
cpSync(resolve(root, 'web/index.html'), resolve(dist, 'index.html'));
cpSync(resolve(root, 'web/public'), dist, { recursive: true });
// API_BASE : URL du backend si le frontend est hébergé séparément (ex. Netlify). Vide = même origine.
writeFileSync(resolve(dist, 'config.js'), `window.__API_BASE__=${JSON.stringify(process.env.API_BASE ?? '')};\n`);
console.log('Frontend construit dans web/dist');
