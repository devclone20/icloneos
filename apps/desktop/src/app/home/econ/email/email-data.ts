export { needsSetup } from '../cli'
export { addressLabel, parseAddress } from './data/addresses'
export { threadBrief } from './data/briefs'
export {
  composeArgv,
  forgetThreads,
  inboxArgv,
  inboxTtlMs,
  mail,
  type MailScope,
  prefetch,
  replyArgv
} from './data/calls'
export { countLabel, onPageOne, publishUnread, unreadCount } from './data/counts'
export { groupByDay, isRecent, rowTime, startOfDay } from './data/days'
export { describeFailure, describeSendFailure, failureSummary } from './data/failures'
export { nextMailbox, NO_ADDRESS } from './data/mailbox'
export {
  adoptFresh,
  findSent,
  mergeOlder,
  mergeRefresh,
  reconcileRead,
  sameMessage,
  samePreview,
  withReadablePreviews
} from './data/merges'
export { AUTO_PAGE_LIMIT, checkRange, neighborAfter, shouldAutoPage, stepFrom } from './data/paging'
export { shapeInbox, shapeMailbox, shapeMessage, shapeReceipt, shapeSearch, shapeThread } from './data/shapers'
export {
  EMAIL_SNAPSHOT_VERSION,
  type EmailSnapshot,
  readMailSnapshot,
  redactCodes,
  restoreSnapshot,
  snapshotOf
} from './data/snapshot'
export {
  type Draft,
  type DraftErrors,
  EMPTY_DRAFT,
  EMPTY_PAGE,
  type MailAddress,
  type Mailbox,
  type MailMessage,
  type MailPage,
  type MailSafety,
  type MailThread,
  PAGE_SIZE,
  SEARCH_MAX,
  type ServerFolder,
  type ThreadMessage
} from './data/types'
export { hasDraft, isEmail, validateDraft, validateReply } from './data/validation'
