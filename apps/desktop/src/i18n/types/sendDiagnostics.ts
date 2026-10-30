// FX-7: the diagnostics report is saved to a file the owner chooses; nothing is uploaded.
export type SendDiagnosticsTranslations = {
  title: string
  lead: string
  parts: {
    context: string
    logs: string
    report: string
  }
  lines: (count: number) => string
  preview: string
  loading: string
  save: string
  saving: string
  cancel: string
  close: string
  savedTitle: string
  savedDescription: (name: string) => string
  failedTitle: string
  reportIssue: string
  reportIssueHint: string
  /** The new issue's title (the only thing the link carries). */
  issueTitle: string
}
