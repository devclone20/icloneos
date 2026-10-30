/** Where the composer's send goes right now (read at send time, from the main renderer's own session refs). */
export interface PetPromptTarget {
  /** The live runtime session on screen (null before it is resumed, or on a new-chat draft). */
  runtimeId: null | string
  /** The stored session on screen (null on a new-chat draft). */
  storedId: null | string
  /** The foreground busy flag — what the composer's own guard reads when there is no runtime id yet. */
  busy: boolean
}

/** The main renderer's session refs, as the app wiring holds them (the very refs the composer's send reads). */
interface PetPromptTargetRefs {
  activeSessionIdRef: { readonly current: null | string }
  busyRef: { readonly current: boolean }
  selectedStoredSessionIdRef: { readonly current: null | string }
}

/**
 * The pet box's target (R3b n-C): the session on screen, read from the refs at the moment of the send — the runtime
 * id from the active session, the stored id from the selected stored session, busy from the composer's busy flag.
 * Kept free of imports so the app wiring can use it without pulling the lazily loaded pet code into its chunk.
 */
export function petPromptTargetOf({
  activeSessionIdRef,
  busyRef,
  selectedStoredSessionIdRef
}: PetPromptTargetRefs): PetPromptTarget {
  return {
    busy: busyRef.current,
    runtimeId: activeSessionIdRef.current,
    storedId: selectedStoredSessionIdRef.current
  }
}
