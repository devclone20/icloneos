// The main process as one text: electron/main.ts, then every electron/main/*.ts module in name order. Source-contract
// tests assert wiring by reading the code (main.ts has no exports), and the wiring now spans these modules.
import fs from 'node:fs'
import path from 'node:path'

export function readMainProcessSource(electronDir: string): string {
  const moduleDir = path.join(electronDir, 'main')

  const modules = fs
    .readdirSync(moduleDir)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()

  return [path.join(electronDir, 'main.ts'), ...modules.map(name => path.join(moduleDir, name))]
    .map(file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    .join('\n')
}
