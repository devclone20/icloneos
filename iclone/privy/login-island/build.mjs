/* One-shot offline build: bundles react + react-dom + @privy-io/react-auth into a
   single self-contained IIFE served by electron/iclone-privy.ts's loopback HTTP
   server next to privy.html. Build-machine only — the output (../privy-login.js)
   is committed so the packaged app never needs node_modules/esbuild at runtime.
   Run: npm install && npm run build */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// fileURLToPath (not `.pathname`) so a path containing spaces — e.g. this repo's
// own "iClone OS" ancestor directory — resolves to a real filesystem path
// instead of a %20-escaped one esbuild can't find on disk.
const out = fileURLToPath(new URL('../privy-login.js', import.meta.url));

// Some transitive deps (pino) probe optional Node-only pretty printers; stub them.
const stubs = {
  name: 'node-stubs',
  setup(b) {
    b.onResolve({ filter: /^(pino-pretty)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}', loader: 'js' }));
  },
};

await build({
  entryPoints: [fileURLToPath(new URL('./src/island.jsx', import.meta.url))],
  outfile: out,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis',
  },
  plugins: [stubs],
});
console.log('built', out);
