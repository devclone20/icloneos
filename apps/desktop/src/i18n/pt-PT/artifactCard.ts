import type { TranslationOverrides } from '../define-locale'

export const artifactCard: TranslationOverrides['artifactCard'] = {
  kind: { code: 'Código', html: 'Página interativa', svg: 'Gráfico' },
  generating: lines => `A gerar… ${lines} linhas`,
  versionBadge: count => `${count} versões`,
  open: 'Abrir'
}
