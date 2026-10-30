/**
 * The one pin for the bundled Virtuals ACP CLI. `@latest` made every build a
 * lottery (a 1.0.34 staging dir after a 1.0.35 release); the version here is
 * the one the dock apps were written and tested against. Bump it deliberately,
 * with the CLI's changelog read — staging, the packaged verification and the
 * app's own self-test all compare against it.
 */
export const ACP_CLI_VERSION = '1.0.38'
