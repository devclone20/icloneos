import type { Translations } from '../types'

export const slash: Translations['slash'] = {
  alsoKnownAs: aliases => `also ${aliases}`,
  fromLibrary: 'from your library',
  needs: names => `needs ${names}`,
  skillsTitle: 'Skills',
  groupPorted: 'icloneOS · from your library',
  groupIclone: 'icloneOS',
  groupLearned: 'Learned',
  groupUpstream: 'Upstream',
  groupHub: 'Hub',
  groupOther: 'Skills',
  skillsEmpty: 'No skills found.',
  skillsFooter: count => `${count} ${count === 1 ? 'skill' : 'skills'} · type /name to open one`,
  skillsRestartNote: 'A newly synced skill reaches the agent after its backend restarts.',
  skillsUnavailable: count =>
    `${count} ${count === 1 ? 'skill needs' : 'skills need'} something this machine lacks (named above).`,
  needsSummary: rows =>
    `${rows.length} ${rows.length === 1 ? 'skill' : 'skills'} from your library ${rows.length === 1 ? 'needs' : 'need'} something this machine lacks: ${rows.join('; ')}.`,
  manifestProblem: message => `manifest.json invalid — ${message}`,
  manifestSummary: rows =>
    `${rows.length} ${rows.length === 1 ? 'skill carries' : 'skills carry'} an invalid manifest.json: ${rows.join('; ')}.`,
  by: (author, license) => `by ${author} (${license})`,
  catalogUnavailable: command => `${command} was not sent: the command catalog could not be read. Try again.`
}
