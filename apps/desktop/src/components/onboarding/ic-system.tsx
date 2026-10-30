// Shim (front IC, 2026-10-19): the primitives live in src/components/ic/**. Delete with the last importer below.
// Importers: app/remote-picker/remote-picker.tsx, app/updates-overlay.tsx, app/updates-overlay.compat-chip.tsx,
// components/{boot-failure-overlay,desktop-install-overlay,error-boundary,find-bar,notifications}.tsx,
// components/onboarding/{flow,index,providers}.tsx. `IcState` here is the system-surface body (contract IC §3).
export * from '@/components/ic/ic-system'
export { IcSurfaceState as IcState } from '@/components/ic/ic-system'
