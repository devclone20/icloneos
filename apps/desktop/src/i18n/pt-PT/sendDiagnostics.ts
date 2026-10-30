import type { TranslationOverrides } from '../define-locale'

export const sendDiagnostics: TranslationOverrides['sendDiagnostics'] = {
  title: 'Guardar um relatório de diagnóstico',
  lead: 'Nada sai deste Mac: o icloneOS escreve o relatório num ficheiro que escolher. Segredos, chaves, tokens, endereços de e-mail e a sua pasta pessoal são removidos antes. Contém:',
  parts: {
    context: 'O que falhou',
    logs: 'O registo recente da aplicação',
    report: 'O último relatório de diagnóstico'
  },
  lines: count => (count === 1 ? '1 linha' : `${count} linhas`),
  preview: 'Mostrar o relatório',
  loading: 'A preparar o relatório…',
  save: 'Guardar num ficheiro…',
  saving: 'A guardar…',
  cancel: 'Cancelar',
  close: 'Fechar',
  savedTitle: 'Relatório guardado',
  savedDescription: name => `Guardado como ${name}. Fica neste Mac; anexe-o a um problema só se quiser.`,
  failedTitle: 'O relatório não foi guardado',
  reportIssue: 'Reportar um problema',
  reportIssueHint:
    'Abre um novo problema no GitHub só com um título. Nada do relatório é enviado; anexe o ficheiro se quiser.',
  issueTitle: 'Relatório de problema do icloneOS'
}
