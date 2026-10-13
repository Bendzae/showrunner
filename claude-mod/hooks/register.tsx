import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionInfo, Sibling, Status } from '../types'

const info = atom({ plugin: 'showrunner-mod', key: 'info' } as const, null)

// Tools that wait on the person even when permissions are skipped.
const ASKS_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])

const REFRESH_MS = 30_000

let tmuxName: string | undefined
let reported: Status | undefined

async function report($: EngineInterface, status: Status) {
  if (tmuxName === undefined || status === reported) return
  reported = status
  await $.process
    .run(['tmux', 'set-environment', '-t', tmuxName, 'CM_STATUS', status])
    .catch(() => undefined)
}

async function refresh($: EngineInterface) {
  if (tmuxName === undefined) return
  const ran = await $.process
    .run(['showrunner', 'session', 'info', tmuxName], { timeoutMs: 20_000 })
    .catch(() => undefined)
  if (ran?.exitCode !== 0) return
  const parsed = JSON.parse(ran.stdout) as SessionInfo
  await update($, info, () => parsed)
}

export const register: Register = on => {
  tmuxName = undefined
  reported = undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started

    const pane = await $.env.get('TMUX_PANE')
    if (pane === undefined) return started
    const ran = await $.process
      .run(['tmux', 'display-message', '-p', '-t', pane, '#S'])
      .catch(() => undefined)
    const name = ran?.stdout.trim()
    if (!name?.startsWith('cm__')) return started

    tmuxName = name
    await report($, 'waiting_input')
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return started
  })

  on('session.end', async ($, e, next) => {
    if (tmuxName !== undefined) {
      await $.process
        .run(['tmux', 'set-environment', '-u', '-t', tmuxName, 'CM_STATUS'])
        .catch(() => undefined)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await report($, 'running')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await report($, 'waiting_input')
      void refresh($)
    }
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask') await report($, 'waiting_permission')
    return verdict
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (ASKS_PERSON.has(e.tool)) await report($, 'waiting_permission')
    const ran = await next(e)
    if (reported === 'waiting_permission') await report($, 'running')
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, info)
    if (current === null || e.props.hasSurvey) return next(e)

    const { Box, Link, Text } = $.ui.resolve(e)
    const diff = current.task_diff ?? current.session_diff
    const isAdhoc = current.task === null
    const ticket = current.linear ? linearId(current.linear) : undefined
    const ticketState = current.linear_state ?? undefined

    return (
      <Box
        flexDirection="row"
        flexWrap="wrap"
        columnGap={1}
        borderStyle="round"
        borderColor="claude"
        paddingX={1}
      >
        <Pill Text={Text} bg="#7C3AED" fg="#FFFFFF" bold>
          🎬 {current.project}
        </Pill>
        <Pill Text={Text} bg={isAdhoc ? '#475569' : '#2563EB'} fg="#FFFFFF" bold>
          {isAdhoc ? '✦ adhoc' : `◆ ${current.task}`}
        </Pill>
        <Text color="#F59E0B" bold>
          ▸ {current.session}
        </Text>
        {diff && diff.added + diff.removed > 0 ? (
          <Text>
            <Text color="diffAdded" bold>
              +{diff.added}
            </Text>{' '}
            <Text color="diffRemoved" bold>
              −{diff.removed}
            </Text>
          </Text>
        ) : null}
        {current.pr ? (
          <Link href={current.pr.url}>
            <Pill Text={Text} bg={prColor(current.pr.state, current.pr.checks)} fg="#FFFFFF" bold>
              {prIcon(current.pr.state, current.pr.checks)} PR {prNumber(current.pr.url)}{' '}
              {current.pr.state}
            </Pill>
          </Link>
        ) : null}
        {ticket && current.linear ? (
          <Link href={current.linear}>
            <Pill
              Text={Text}
              bg={ticketState?.color ?? '#5E6AD2'}
              fg={readableOn(ticketState?.color ?? '#5E6AD2')}
              bold
            >
              {ticketGlyph(ticketState?.type)} {ticket}
              {ticketState ? ` · ${ticketState.name}` : ''}
            </Pill>
          </Link>
        ) : null}
        {current.siblings.map(sibling => (
          <Text key={sibling.name}>
            <Text color={statusColor(sibling)}>{statusGlyph(sibling)}</Text>
            <Text color="subtle"> {sibling.name}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}

function Pill({
  Text,
  bg,
  fg,
  bold,
  children,
}: {
  Text: any
  bg: string
  fg: string
  bold?: boolean
  children?: unknown
}) {
  return (
    <Text backgroundColor={bg} color={fg} bold={bold}>
      {' '}
      {children}{' '}
    </Text>
  )
}

function statusGlyph(sibling: Sibling): string {
  switch (sibling.status) {
    case 'running':
      return '●'
    case 'waiting_permission':
      return '▲'
    case 'waiting_input':
      return '○'
    default:
      return '·'
  }
}

function statusColor(sibling: Sibling): string {
  switch (sibling.status) {
    case 'running':
      return '#22C55E'
    case 'waiting_permission':
      return '#F59E0B'
    case 'waiting_input':
      return '#94A3B8'
    default:
      return 'subtle'
  }
}

function prColor(state: string, checks: string | null): string {
  if (state === 'merged') return '#8B5CF6'
  if (state === 'closed' || checks === 'failing') return '#DC2626'
  if (state === 'draft') return '#6B7280'
  if (checks === 'pending') return '#D97706'
  return '#16A34A'
}

function prIcon(state: string, checks: string | null): string {
  if (state === 'merged') return '⇄'
  if (state === 'closed') return '✕'
  if (checks === 'failing') return '✗'
  if (checks === 'pending') return '◷'
  return '✓'
}

function prNumber(url: string): string {
  return `#${url.split('/').pop()}`
}

function linearId(url: string): string | undefined {
  return url.match(/\/issue\/([A-Za-z]+-\d+)/)?.[1]?.toUpperCase()
}

/** Linear's workflow state types, drawn the way Linear's own icons read. */
function ticketGlyph(type: string | undefined): string {
  switch (type) {
    case 'completed':
      return '✔'
    case 'canceled':
      return '✕'
    case 'started':
      return '◐'
    case 'unstarted':
      return '○'
    case 'backlog':
    case 'triage':
      return '◌'
    default:
      return '◇'
  }
}

/** Black or white text, whichever reads on the `#rrggbb` background. */
function readableOn(hex: string): string {
  const rgb = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!rgb) return '#FFFFFF'
  const [r, g, b] = rgb.slice(1).map(c => parseInt(c, 16))
  return 0.299 * r! + 0.587 * g! + 0.114 * b! > 150 ? '#111111' : '#FFFFFF'
}
