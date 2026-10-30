/**
 * `@/app/skills/mcp-tab` is a published plugin-SDK module path
 * (`src/sdk/index.ts` re-exports `McpTab` from it), so it stays exactly where
 * it was while the tab itself lives in `./mcp/` split under 900 lines a file.
 */
export { McpTab } from './mcp/tab'
