import { useGatewayHandlers } from './machine/gateway-handlers'
import { useGatewayConnectionState } from './machine/gateway-state'
import { GatewayView } from './machine/gateway-view'

export { normalizeGatewaySettingsState, savedCloudConnectionUrl } from './machine/gateway-model'

// `embedded` trims the page chrome for reuse inside the boot-failure recovery
// card: the outer title/intro, the "Save for next restart" action, and the
// Diagnostics row are redundant there (the card owns its header + a single
// reconnect action), so only the connection controls render.
export function GatewaySettings({ embedded = false }: { embedded?: boolean } = {}) {
  const connection = useGatewayConnectionState()
  const handlers = useGatewayHandlers(connection)

  return <GatewayView connection={connection} embedded={embedded} handlers={handlers} />
}
