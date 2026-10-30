import type { TranslationOverrides } from '../define-locale'

export const slash: TranslationOverrides['slash'] = {
  alsoKnownAs: aliases => `também ${aliases}`,
  fromLibrary: 'da sua biblioteca',
  needs: names => `precisa de ${names}`,
  skillsTitle: 'Competências',
  groupPorted: 'icloneOS · da sua biblioteca',
  groupIclone: 'icloneOS',
  groupLearned: 'Aprendidas',
  groupUpstream: 'De origem',
  groupHub: 'Hub',
  groupOther: 'Competências',
  skillsEmpty: 'Nenhuma competência encontrada.',
  skillsFooter: count => `${count} ${count === 1 ? 'competência' : 'competências'} · escreva /nome para abrir uma`,
  skillsRestartNote: 'Uma competência acabada de sincronizar chega ao agente depois de o respetivo backend reiniciar.',
  skillsUnavailable: count =>
    `${count} ${count === 1 ? 'competência precisa' : 'competências precisam'} de algo que falta nesta máquina (indicado acima).`,
  needsSummary: rows =>
    `${rows.length} ${rows.length === 1 ? 'competência' : 'competências'} da sua biblioteca ${rows.length === 1 ? 'precisa' : 'precisam'} de algo que falta nesta máquina: ${rows.join('; ')}.`,
  manifestProblem: message => `manifest.json inválido — ${message}`,
  manifestSummary: rows =>
    `${rows.length} ${rows.length === 1 ? 'competência tem' : 'competências têm'} um manifest.json inválido: ${rows.join('; ')}.`,
  by: (author, license) => `de ${author} (${license})`,
  catalogUnavailable: command =>
    `${command} não foi enviado: não foi possível ler o catálogo de comandos. Tente novamente.`
}
