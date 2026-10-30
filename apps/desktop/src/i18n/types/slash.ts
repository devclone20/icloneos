/** V3-B — the slash popover tags, the `/skills` list and the Skills page line about ported skills. */
export type SlashTranslations = {
  /** Popover meta suffix for a command that is also reachable under other names: "also /compact". */
  alsoKnownAs: (aliases: string) => string
  /** Popover tag on a skill ported from the owner's library. */
  fromLibrary: string
  /** Popover / list tag naming what this machine lacks: "needs ffmpeg, MCP davinci-resolve". */
  needs: (names: string) => string
  /** `/skills` output. */
  skillsTitle: string
  groupPorted: string
  groupIclone: string
  groupLearned: string
  groupUpstream: string
  groupHub: string
  groupOther: string
  skillsEmpty: string
  skillsFooter: (count: number) => string
  skillsRestartNote: string
  skillsUnavailable: (count: number) => string
  /** Skills page subtitle: ported skills that cannot run here, named with what each lacks. */
  needsSummary: (rows: readonly string[]) => string
  /** A ported skill whose manifest.json fails the schema — named wherever the row appears, never silent (F8). */
  manifestProblem: (message: string) => string
  /** Skills page subtitle: the ported skills with a bad manifest, each with its problem. */
  manifestSummary: (rows: readonly string[]) => string
  /** Third-party attribution on a row: "by Rodrigo Lopes (MIT)". */
  by: (author: string, license: string) => string
  /** A typed command that was NOT sent because the backend's command catalog could not be read (F4: fail closed). */
  catalogUnavailable: (command: string) => string
}
