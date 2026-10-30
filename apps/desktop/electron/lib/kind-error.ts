/**
 * iclone os — a tagged Error. `kind` is the code the UI maps to its copy
 * (an SSH_ERROR, a lifecycle kind such as 'superseded'); `cause` stays an
 * enumerable own property. One constructor for every tagged throw in main.
 */
export type KindError = Error & { kind: string }

export function kindError(kind: string, message: string, extra?: { cause: unknown }): KindError {
  return Object.assign(new Error(message), { kind }, extra)
}
