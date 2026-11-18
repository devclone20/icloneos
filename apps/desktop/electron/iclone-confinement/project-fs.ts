/**
 * v0.0.8 FX-ASAR — the file system every confinement check uses on a project path: Electron's `original-fs` (no asar
 * interception: a `*.asar` file is a file) in the app, `node:fs` under plain Node. The selection lives in
 * hardlinks-walk.ts, whose worker build may import nothing relative; this module is the name the rest of main uses.
 */
export { type GetBuiltinModule, type ProjectFs, projectFs, selectProjectFs } from './hardlinks-walk'
