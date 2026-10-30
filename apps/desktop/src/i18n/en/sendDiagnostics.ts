import type { Translations } from '../types'

export const sendDiagnostics: Translations['sendDiagnostics'] = {
  title: 'Save a diagnostics report',
  lead: 'Nothing leaves this Mac: icloneOS writes the report to a file you choose. Secrets, keys, tokens, e-mail addresses and your home folder are removed first. It contains:',
  parts: {
    context: 'What failed',
    logs: 'The recent app log',
    report: 'The last diagnostics report'
  },
  lines: count => (count === 1 ? '1 line' : `${count} lines`),
  preview: 'Show the report',
  loading: 'Preparing the report…',
  save: 'Save to a file…',
  saving: 'Saving…',
  cancel: 'Cancel',
  close: 'Close',
  savedTitle: 'Report saved',
  savedDescription: name => `Saved as ${name}. It stays on this Mac; attach it to an issue only if you choose to.`,
  failedTitle: 'The report was not saved',
  reportIssue: 'Report an issue',
  reportIssueHint:
    'Opens a new issue on GitHub with a title only. Nothing from the report is sent; attach the file yourself if you want to.',
  issueTitle: 'Problem report from icloneOS'
}
