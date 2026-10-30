import { CompactButton } from '@/app/session/compact'

/** The card footer's single mount point for G2's "Compact session" action. */
export function CompactSlot({ sessionId }: { sessionId: string }) {
  return <CompactButton sessionId={sessionId} variant="footer" />
}
