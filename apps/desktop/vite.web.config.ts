// icloneOS Web (the "Chrome app"): the renderer as a same-origin PWA served by the
// Hermes gateway (HERMES_WEB_DIST). Separate file so the Electron build config
// (vite.config.ts, the default mode the labs run) stays untouched.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { type ConfigEnv, defineConfig, mergeConfig, type Plugin, type UserConfig } from 'vite'

import { OFFLINE_HTML, serviceWorkerSource, WEB_THEME_COLOR, webManifest } from './src/web-shim/sw-source'
import baseConfig from './vite.config'

const here = import.meta.dirname
const version: string = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')).version
const MAIN_ENTRY = '<script type="module" src="/src/main.tsx"></script>'

function icloneWeb(): Plugin {
  return {
    name: 'iclone-web',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes(MAIN_ENTRY)) {
          throw new Error('index.html no longer loads /src/main.tsx; update vite.web.config.ts')
        }

        return html
          .replace(MAIN_ENTRY, `<script type="module" src="/src/web-shim/install.ts"></script>\n    ${MAIN_ENTRY}`)
          .replace(
            '</head>',
            `  <link rel="manifest" href="/manifest.webmanifest" />\n    <meta name="theme-color" content="${WEB_THEME_COLOR}" />\n  </head>`
          )
      }
    },
    generateBundle(_options, bundle) {
      const names = Object.keys(bundle).sort().join('\n')
      const cacheName = `icloneos-web-${version}-${createHash('sha256').update(names).digest('hex').slice(0, 12)}`

      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(webManifest(version), null, 2)
      })
      this.emitFile({
        type: 'asset',
        fileName: 'icon-512.png',
        source: readFileSync(path.join(here, 'assets', 'icon.png'))
      })
      this.emitFile({ type: 'asset', fileName: 'offline.html', source: OFFLINE_HTML })
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(cacheName) })
    }
  }
}

export default defineConfig(async (env: ConfigEnv) => {
  const base = await (baseConfig as (env: ConfigEnv) => Promise<UserConfig> | UserConfig)(env)

  return mergeConfig(base, {
    base: '/',
    build: { emptyOutDir: true, outDir: 'dist-web' },
    define: { 'import.meta.env.VITE_ICLONE_WEB_VERSION': JSON.stringify(version) },
    plugins: [icloneWeb()]
  })
})
