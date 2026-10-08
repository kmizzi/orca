import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** Saved chats can outlive their agent registration; both bound the client's audience. */
export function structuredAgentSessionKnownAgentIds(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents' | 'store'>
): readonly string[] {
  return [
    ...new Set([
      ...deps.agents.definitions().map(({ agent }) => agent),
      ...deps.store.listRecords().map(({ provider }) => provider)
    ])
  ]
}
