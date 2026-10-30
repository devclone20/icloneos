export type ArtifactCardTranslations = {
  kind: Record<'code' | 'html' | 'svg', string>
  generating: (lines: number) => string
  versionBadge: (count: number) => string
  open: string
}
