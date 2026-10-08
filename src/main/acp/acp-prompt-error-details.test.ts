import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PROVIDER_DIAGNOSTIC_CHARS } from '../../shared/agent-session-failure'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { AcpAgentError, AcpInvalidResponseError } from './acp-errors'
import { AcpJsonRpcPeer } from './acp-json-rpc-peer'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import { openAcpFixtureRig } from './acp-timeline-fixture.test-support'
import { acpPromptErrorDetail } from './acp-turn-failures'

afterEach(closeProviderTimelineRigs)

describe('shared ACP prompt error details', () => {
  it.each([undefined, null, '', ' \n '])('keeps the outer error without details: %j', (data) => {
    expect(acpPromptErrorDetail(new AcpAgentError(-32603, 'Internal error', data), 'OMP')).toBe(
      'OMP: Internal error'
    )
  })

  it.each([
    ['Check your provider setup.', 'Check your provider setup.'],
    [{ details: 'Use /login, then /model.', other: 'not rendered' }, 'Use /login, then /model.'],
    [{ message: 'API rejected the request.' }, '{"message":"API rejected the request."}'],
    [{ details: 12 }, '{"details":12}'],
    [{ details: ' ' }, '{"details":" "}'],
    [['one', 'two'], '["one","two"]'],
    [false, 'false'],
    [12, '12']
  ])('reads string, textual details, or serialized data: %j', (data, detail) => {
    for (const agent of ['OMP', 'Grok', 'OpenCode']) {
      expect(acpPromptErrorDetail(new AcpAgentError(-32603, 'Internal error', data), agent)).toBe(
        `${agent}: Internal error: ${detail}`
      )
    }
  })

  it('uses the existing diagnostic bound for long data, and no invented empty reason', () => {
    const details = `Check your provider setup. ${'x'.repeat(1000)}`
    expect(
      acpPromptErrorDetail(new AcpAgentError(-32603, 'Internal error', { details }), 'OMP')
    ).toBe(`OMP: Internal error: ${details}`.slice(0, MAX_PROVIDER_DIAGNOSTIC_CHARS))
    expect(acpPromptErrorDetail(new AcpAgentError(-32603, '', undefined), 'OMP')).toBe('')
    expect(acpPromptErrorDetail(new AcpAgentError(-32603, '', 'Choose a model.'), 'OMP')).toBe(
      'OMP: Choose a model.'
    )
  })

  it('keeps the outer reason when data cannot be serialized', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const data of [
      circular,
      { value: 1n },
      {
        toJSON: () => {
          throw new Error('unreadable')
        }
      }
    ]) {
      expect(acpPromptErrorDetail(new AcpAgentError(-32603, 'Provider failed', data), 'OMP')).toBe(
        'OMP: Provider failed'
      )
    }
  })

  it('reads the captured Windows OMP error into one actionable failed-turn journal row', async () => {
    const fixture = await readFile(
      new URL('./fixtures/omp-v17-windows-prompt-no-model.jsonl', import.meta.url),
      'utf8'
    )
    const frames = fixture.trim().split('\n')
    const agent = new AcpScriptedAgent()
    const peer = new AcpJsonRpcPeer(agent.stdout, agent.stdin)
    try {
      for (const [index, method] of ['initialize', 'session/new'].entries()) {
        const reply = peer.request(method, {})
        agent.stdout.write(`${frames[index]}\n`)
        await reply
      }
      const f = await openAcpFixtureRig({ dialect: OMP_ACP_DIALECT, agentName: 'OMP' })
      const lane = f.lane()
      f.apply(lane.openPrompt('prompt-1', 1000).events)
      const reply = peer
        .request('session/prompt', { sessionId: 'session-1', prompt: [] })
        .catch((error: unknown) => error)
      agent.stdout.write(`${frames[2]}\n`)
      const error = await reply
      if (!(error instanceof AcpAgentError)) {
        throw new Error('Expected the captured agent RPC error')
      }
      expect(error).toMatchObject({
        code: -32603,
        message: 'Internal error',
        data: { details: expect.stringContaining('No model selected.') }
      })
      f.apply(lane.promptFailed('prompt-1', error, 1001))
      f.apply(lane.promptFailed('prompt-1', error, 1002))
      const rows = await f.rig.rows()
      const text = rows
        .filter((row) => row.body.kind === 'status')
        .flatMap((row) => (row.body.kind === 'status' ? [row.body.text] : []))
      expect(text).toHaveLength(1)
      expect(text[0]).toBe(
        'OMP: Internal error: No model selected.\n\n' +
          'Use /login, set an API key environment variable, or create C:\\qa\\.omp\\agent\\agent.db\n\n' +
          'Then use /model to select a model.'
      )
      expect((await f.rig.turns()).map((turn) => [turn.state, turn.outcome])).toEqual([
        ['completed', 'failure']
      ])
    } finally {
      peer.close()
      agent.close()
    }
  })

  it('uses the shared data reader for a Grok prompt refused before its turn begins', async () => {
    const f = await openAcpFixtureRig({ dialect: GROK_ACP_DIALECT, agentName: 'Grok' })
    const lane = f.lane()
    lane.openPrompt('prompt-1', 1000)
    expect(
      lane.promptRefused(
        'prompt-1',
        new AcpAgentError(-32603, 'Internal error', { details: 'Choose a provider and retry.' })
      )
    ).toBe('Grok: Internal error: Choose a provider and retry.')
    expect(lane.promptRefused('prompt-1', new AcpAgentError(-32603, 'Internal error'))).toBeNull()
    expect(await f.rig.rows()).toEqual([])
  })

  it('does not present malformed protocol data as agent guidance', async () => {
    const f = await openAcpFixtureRig({ dialect: OMP_ACP_DIALECT, agentName: 'OMP' })
    const lane = f.lane()
    f.apply(lane.openPrompt('prompt-1', 1000).events)
    f.apply(
      lane.promptFailed(
        'prompt-1',
        new AcpInvalidResponseError('Unreadable response', { details: 'No model selected.' }),
        1001
      )
    )
    expect(
      (await f.rig.rows()).filter((row) => row.body.kind === 'status').map((row) => row.body)
    ).toEqual([{ kind: 'status', tone: 'error', text: 'OMP ended this turn with an error.' }])
  })
})
