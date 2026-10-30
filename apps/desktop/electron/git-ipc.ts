// IPC surface for git-driven features: worktree management ("Start work"),
// the composer coding rail's repo status, the Codex-style review pane, and
// repo-first project discovery. Extracted from main.ts; the git/gh binary
// resolvers stay injected because main.ts also uses them for self-update and
// plugin installs.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import { scanGitRepos } from './git-repo-scan'
import {
  fileDiffVsHead,
  repoStatus,
  reviewCommit,
  reviewCommitContext,
  reviewCreatePr,
  reviewDiff,
  reviewFetchPrComment,
  reviewList,
  reviewPrList,
  reviewPush,
  reviewRevert,
  reviewRevParse,
  reviewShipInfo,
  reviewStage,
  reviewUnstage
} from './git-review-ops'
import {
  addWorktree,
  listBaseBranches,
  listBranches,
  listWorktrees,
  removeWorktree,
  switchBranch
} from './git-worktree-ops'

interface GitIpcDeps {
  resolveGitBinary: () => string
  resolveGhBinary: () => string
  // Every hermes:git:* call runs git or gh in a directory the caller names, and several write (stage, revert, commit,
  // push, worktrees): only the app's own renderer may drive them, as for the terminal (ipc-sender-guard.ts; G-42,
  // review R1-A minor 1).
  isTrustedSender: (event: IpcMainInvokeEvent, channel: string) => boolean
}

type GitHandler = Parameters<typeof ipcMain.handle>[1]

export function registerGitIpc({ resolveGitBinary, resolveGhBinary, isTrustedSender }: GitIpcDeps) {
  // ipcMain.handle behind the sender guard: a refused sender gets a rejected promise and nothing runs.
  const handle = (channel: string, listener: GitHandler) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (isTrustedSender(event, channel) !== true) {
        throw new Error('Git is only available to the app window')
      }

      return listener(event, ...args)
    })

  // Git-driven worktree management ("Start work" flow). Errors surface to the
  // renderer as rejected promises so it can toast a friendly message.
  handle('hermes:git:worktreeList', async (_event, repoPath) => listWorktrees(repoPath, resolveGitBinary()))

  handle('hermes:git:worktreeAdd', async (_event, repoPath, options) =>
    addWorktree(repoPath, options || {}, resolveGitBinary())
  )

  handle('hermes:git:worktreeRemove', async (_event, repoPath, worktreePath, options) =>
    removeWorktree(repoPath, worktreePath, options || {}, resolveGitBinary())
  )

  handle('hermes:git:branchSwitch', async (_event, repoPath, branch) =>
    switchBranch(repoPath, branch, resolveGitBinary())
  )

  handle('hermes:git:branchList', async (_event, repoPath) => listBranches(repoPath, resolveGitBinary()))

  handle('hermes:git:baseBranchList', async (_event, repoPath) => listBaseBranches(repoPath, resolveGitBinary()))

  // Compact repo status (branch, ahead/behind, change counts + files) for the
  // composer coding rail. Returns null on a non-repo / remote backend so the rail
  // hides cleanly rather than erroring.
  handle('hermes:git:repoStatus', async (_event, repoPath) => repoStatus(repoPath, resolveGitBinary()))

  // Codex-style review pane: list changed files for a scope, fetch one file's
  // unified diff, and stage / unstage / revert. Reads return empty on failure;
  // mutations reject so the renderer can toast.
  handle('hermes:git:review:list', async (_event, repoPath, scope, baseRef) =>
    reviewList(repoPath, scope, baseRef, resolveGitBinary())
  )
  handle('hermes:git:review:diff', async (_event, repoPath, filePath, scope, baseRef, staged) =>
    reviewDiff(repoPath, filePath, scope, baseRef, staged, resolveGitBinary())
  )
  // Working-tree-vs-HEAD diff for one file (the preview's "show the diff" view).
  handle('hermes:git:fileDiff', async (_event, repoPath, filePath) =>
    fileDiffVsHead(repoPath, filePath, resolveGitBinary())
  )
  handle('hermes:git:review:stage', async (_event, repoPath, filePath) =>
    reviewStage(repoPath, filePath ?? null, resolveGitBinary())
  )
  handle('hermes:git:review:unstage', async (_event, repoPath, filePath) =>
    reviewUnstage(repoPath, filePath ?? null, resolveGitBinary())
  )
  handle('hermes:git:review:revert', async (_event, repoPath, filePath) =>
    reviewRevert(repoPath, filePath ?? null, resolveGitBinary())
  )
  handle('hermes:git:review:revParse', async (_event, repoPath, ref) =>
    reviewRevParse(repoPath, ref, resolveGitBinary())
  )
  handle('hermes:git:review:commit', async (_event, repoPath, message, push) =>
    reviewCommit(repoPath, message, Boolean(push), resolveGitBinary())
  )
  handle('hermes:git:review:commitContext', async (_event, repoPath) =>
    reviewCommitContext(repoPath, resolveGitBinary())
  )
  handle('hermes:git:review:push', async (_event, repoPath) => reviewPush(repoPath, resolveGitBinary()))
  handle('hermes:git:review:shipInfo', async (_event, repoPath) => reviewShipInfo(repoPath, resolveGhBinary()))
  handle('hermes:git:review:prList', async (_event, repoPath, branches, numbers) =>
    reviewPrList(repoPath, resolveGhBinary(), branches, numbers)
  )
  handle('hermes:git:review:fetchPrComment', async (_event, repoPath, url) =>
    reviewFetchPrComment(repoPath, resolveGhBinary(), url)
  )
  handle('hermes:git:review:createPr', async (_event, repoPath) =>
    reviewCreatePr(repoPath, resolveGitBinary(), resolveGhBinary())
  )

  // Repo-first project discovery: scan bounded roots for git repos (pure fs walk,
  // no native addon). Never throws to the renderer — failures yield an empty list.
  handle('hermes:git:scanRepos', async (_event, roots, options) => {
    try {
      return await scanGitRepos(roots || [], options || {})
    } catch {
      return []
    }
  })
}
