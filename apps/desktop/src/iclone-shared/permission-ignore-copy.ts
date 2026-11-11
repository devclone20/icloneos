/**
 * V3-F (critic F-17), F40 - the words of the Ignore permissions alert. Main shows them on a NATIVE dialog (a compromised
 * window cannot click it or steal its focus), so they live here, where main can read them. The dialog lists exactly what
 * the mode lifts and what stays refused. English only, by the owner's rule: no other locale can keep an older promise.
 */

interface IgnoreConfirmCopy {
  title: string
  lead: string
  lifts: readonly string[]
  still: string
  once: string
  confirm: string
  cancel: string
}

const WORDS: Omit<IgnoreConfirmCopy, 'title'> = {
  lead: 'Your agent stops asking about anything. Without asking, it can:',
  lifts: [
    'move your iNFTs and send your keys',
    'spend your money',
    'ignore every Privacy switch you turned off',
    'write, delete, run and install anything confinement allows, and with its commands anything you can while it is off',
    'read and change your shell startup files, git config, launch agents and keys with its file tools, outside confinement, and only Activity tells you',
    'use your admin password',
    'overwrite its own permission files, though icloneOS does not take an edit it cannot verify',
    'click this app’s own controls, if computer use is on'
  ],
  still:
    'A malicious page or file it reads can lead it to do any of this. Nothing protects you from that. What still refuses: destroying the whole disk, your home folder or the system; a recursive delete whose whole target is a variable or command output it cannot read, or a recursive delete it can read as aimed at the disk, a home folder or the system, also when a variable left empty would make it so, or by a command whose name it cannot read, or a recursive delete whose targets or options it cannot fully read; a call too unreadable to check (a patch whose files it cannot name, a write that names no file, or arguments it cannot read); deny rules you wrote yourself; and the file tools on the runtime’s own stores (writes to state.db, sessions, tokens, pairing, vault, the browser profile and the runtime’s own .env; reads of tokens, vault, the browser profile, auth.json, auth.lock, that .env and webhook subscriptions). These are checks in the app, not a wall in the kernel, so a program, or a command built at run time, encoded or passed through eval, can get round them.',
  once:
    'This alert shows once. After this, Ignore is one touch anywhere: a session, a project or the default for new sessions. Whatever is waiting for your answer when you turn it on goes through at once.',
  confirm: 'Ignore permissions',
  cancel: 'Keep the current mode'
}

/** S11: what a choice made in an empty chat reaches. */
export const NEW_SESSION_SCOPE_LINE = 'Only that chat. Other new chats keep the mode set in Settings.'

export function ignoreConfirmCopy(_locale?: string, scope: string = 'project'): IgnoreConfirmCopy {
  return {
    ...WORDS,
    title:
      scope === 'standing'
        ? 'Ignore permissions for every session with no mode of its own?'
        : scope === 'session'
          ? 'Ignore permissions for this session?'
          : scope === 'new-session'
            ? 'Ignore permissions for the chat this window starts next?'
            : 'Ignore permissions for this project?'
  }
}
