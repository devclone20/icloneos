// Shim (front IC, 2026-10-19): the primitives live in src/components/ic/**. Delete with the last importer below.
// Importers: app/profiles/{index,create-profile-dialog,delete-profile-dialog,rename-profile-dialog,soul-editor,
// profile-dialog-footer}.tsx + ic-dialog.test.tsx, app/messaging/{index,messaging-field,platform-detail,
// platform-state.ts}, app/skills/{index,rail-parts,skill-detail,skills-tab,toolsets-tab,embedded-hub-picker}.tsx
// and the four MCP tab files under app/skills (front E3d5 is live in app/skills — do not re-point it).
export * from '@/components/ic/ic-page'
