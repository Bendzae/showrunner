import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Loaded,
  PullRequest,
  SessionInfo,
  Sibling,
  Status,
  Thread,
  TicketView,
} from '../types'

const info = atom({ plugin: 'showrunner-mod', key: 'info' } as const, null)
const ticket = atom({ plugin: 'showrunner-mod', key: 'ticket' } as const, null)

const pr = atom({ plugin: 'showrunner-mod', key: 'pr' } as const, null)

const moduleTags = { plugin: 'monorepo-touched', key: 'tags' } as const

/** The band's colors, each toned a little toward a dark background. */
const PALETTE = {
  text: '#F3F4F6',
  project: tone('#7C3AED'),
  task: tone('#2563EB'),
  adhoc: tone('#475569'),
  session: tone('#F59E0B'),
  ok: tone('#22C55E'),
  bad: tone('#DC2626'),
  warn: tone('#D97706'),
  idle: tone('#94A3B8'),
  prOpen: tone('#16A34A'),
  prFailing: tone('#DC2626'),
  prPending: tone('#D97706'),
  prMerged: tone('#8B5CF6'),
  prDraft: tone('#6B7280'),
  linear: tone('#5E6AD2'),
  border: tone('#22D3EE'),
} as const

const TICKET_PANE = 'ticket'
const PR_PANE = 'pr'

// Tools that wait on the person even when permissions are skipped.
const ASKS_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])

const REFRESH_MS = 30_000

let tmuxName: string | undefined
let reported: Status | undefined
let conversation: string | undefined

/** Keep the session record on the conversation this session runs, so a
 * recreated session resumes it (it changes on /clear). */
async function syncConversation($: EngineInterface) {
  if (tmuxName === undefined) return
  const id = await $.session.id()
  if (id === conversation) return
  conversation = id
  await $.process
    .run(['showrunner', 'session', 'set-conversation', tmuxName, id])
    .catch(() => undefined)
}

/** Whether an answer ends by asking the person something they need to
 * answer: only a closing `?` is worth a quick check by the small model. */
async function asksPerson($: EngineInterface, answer: string): Promise<boolean> {
  const tail = answerTail(answer)
  if (!tail.includes('?')) return false
  const verdict = await $.model
    .classify(
      `Does this end of an assistant's reply ask the user one or more questions they need to answer before work can continue? Offers like "Want me to …?" count only if the reply waits on the answer.\n\n${tail}`,
      ['asks', 'done'],
    )
    .catch(() => undefined)
  return verdict === 'asks'
}

async function loadPr($: EngineInterface) {
  if (tmuxName === undefined) return
  await update($, pr, (): Loaded<PullRequest> => ({ status: 'loading' }))
  const ran = await $.process
    .run(['showrunner', 'session', 'pr', tmuxName], { timeoutMs: 30_000 })
    .catch(() => undefined)
  const view: Loaded<PullRequest> =
    ran?.exitCode === 0
      ? { status: 'ready', value: JSON.parse(ran.stdout) }
      : {
          status: 'error',
          message: failure(ran?.stderr),
        }
  await update($, pr, () => view)
}

async function sendThreadsToClaude($: EngineInterface, threads: Thread[]) {
  const text = threads
    .map(
      t =>
        `- ${t.path}${t.line ? `:${t.line}` : ''} (${t.author ?? 'reviewer'}): ${firstParagraph(t.body)}`,
    )
    .join('\n')
  await $.prompt.fill({
    text: `Address these unresolved review comments on the PR:\n${text}\n`,
    mode: 'insert',
  })
}

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

/** What a failed `showrunner` call says, or that showrunner needs updating. */
function failure(stderr: string | undefined): string {
  const message = stderr?.replace(/^Error: /, '').trim()
  if (message?.includes('unknown session command')) {
    return 'This needs a newer showrunner (0.29.5 or later): update it and try again.'
  }
  return message || 'showrunner did not answer'
}

async function loadTicket($: EngineInterface) {
  if (tmuxName === undefined) return
  await update($, ticket, (): TicketView => ({ status: 'loading' }))
  const ran = await $.process
    .run(['showrunner', 'session', 'ticket', tmuxName], { timeoutMs: 20_000 })
    .catch(() => undefined)
  const view: TicketView =
    ran?.exitCode === 0
      ? { status: 'ready', ticket: JSON.parse(ran.stdout) }
      : {
          status: 'error',
          message: failure(ran?.stderr),
        }
  await update($, ticket, () => view)
}

export const register: Register = on => {
  tmuxName = undefined
  reported = undefined
  conversation = undefined

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
    await $.command
      .register({ name: 'ticket', description: "Show this task's Linear ticket in a pane" })
      .catch(() => undefined)
    await $.command
      .register({ name: 'pr', description: "Show this task's PR: checks and open review comments" })
      .catch(() => undefined)
    await syncConversation($)
    await report($, 'waiting_input')
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return started
  })

  on('command.run', { command: 'ticket' }, async $ => {
    const current = await read($, info)
    const id = current?.linear ? linearId(current.linear) : undefined
    if (id === undefined) return { text: 'No Linear ticket is linked to this task.' }
    await $.ui.open({ id: TICKET_PANE, title: id, columns: 72, closeOnEscape: true })
    void loadTicket($)
    return { text: `Opened ${id}.` }
  })

  on('ui.render', { component: 'Pane', requestId: TICKET_PANE }, async ($, e) => {
    const { Box, Link, Markdown, Text } = $.ui.resolve(e)
    const view = await read($, ticket)
    if (view === null || view.status === 'loading') {
      return <Text color="subtle">Loading ticket…</Text>
    }
    if (view.status === 'error') {
      return <Text color="error">{view.message}</Text>
    }
    const t = view.ticket
    const comments = t.comments.nodes
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Link href={t.url}>
            <Pill Text={Text} bg={tone(t.state.color)} fg={PALETTE.text} bold>
              {ticketGlyph(t.state.type)} {t.identifier} · {t.state.name}
            </Pill>
          </Link>
          {t.labels.nodes.map(label => (
            <Text key={label.name} color={label.color}>
              ● {label.name}
            </Text>
          ))}
        </Box>
        <Text bold>{t.title}</Text>
        <Text color="subtle">
          {t.assignee ? `👤 ${t.assignee.displayName}` : '👤 unassigned'}
          {t.priorityLabel !== 'No priority' ? `  ⚑ ${t.priorityLabel}` : ''}
          {t.creator ? `  ✎ ${t.creator.displayName}` : ''}
        </Text>
        <Markdown text={t.description?.trim() || '_No description._'} />
        {comments.length > 0 ? (
          <Box flexDirection="column" gap={1}>
            <Text bold color="claude">
              💬 {comments.length} comment{comments.length === 1 ? '' : 's'}
            </Text>
            {comments.map(comment => (
              <Box key={comment.createdAt} flexDirection="column">
                <Text color="subtle">
                  {comment.user?.displayName ?? 'someone'} · {comment.createdAt.slice(0, 10)}
                </Text>
                <Markdown text={comment.body} />
              </Box>
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })

  on('command.run', { command: 'pr' }, async $ => {
    const current = await read($, info)
    if (current === null || current.task === null) return { text: 'Adhoc sessions have no PR.' }
    await $.ui.open({ id: PR_PANE, title: 'PR', columns: 80, closeOnEscape: true })
    void loadPr($)
    return { text: 'Opened the PR pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PR_PANE }, async ($, e) => {
    const { Box, Button, Link, Markdown, Text } = $.ui.resolve(e)
    const view = await read($, pr)
    if (view === null || view.status === 'loading') {
      return <Text color="subtle">Loading PR…</Text>
    }
    if (view.status === 'error') {
      return <Text color="error">{view.message}</Text>
    }
    const p = view.value
    const count = (state: string) => p.checks.filter(c => c.state === state).length
    const attention = p.checks.filter(c => c.state === 'fail' || c.state === 'pending')
    const checksState = count('fail') > 0 ? 'failing' : count('pending') > 0 ? 'pending' : null
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Link href={p.url}>
            <Pill Text={Text} bg={prColor(p.state, checksState)} fg={PALETTE.text} bold>
              {prIcon(p.state, checksState)} PR #{p.number} {p.state}
            </Pill>
          </Link>
          {p.review ? <Text color={reviewColor(p.review)}>{reviewLabel(p.review)}</Text> : null}
          <Text>
            <Text color="diffAdded" bold>
              +{p.additions}
            </Text>{' '}
            <Text color="diffRemoved" bold>
              −{p.deletions}
            </Text>
            <Text color="subtle"> in {p.changed_files} files</Text>
          </Text>
        </Box>
        <Text bold>{p.title}</Text>
        <Text>
          <Text color={PALETTE.ok}>✓ {count('pass')} passed</Text>
          <Text color="subtle"> · </Text>
          <Text color={PALETTE.bad}>✗ {count('fail')} failed</Text>
          <Text color="subtle"> · </Text>
          <Text color={PALETTE.warn}>◷ {count('pending')} pending</Text>
          <Text color="subtle"> · ⤼ {count('skipped')} skipped</Text>
        </Text>
        {attention.map((check, i) => (
          <Text key={`check-${i}`}>
            <Text color={check.state === 'fail' ? PALETTE.bad : PALETTE.warn}>
              {check.state === 'fail' ? '✗' : '◷'}{' '}
            </Text>
            {check.url ? (
              <Link href={check.url}>{check.name ?? 'check'}</Link>
            ) : (
              <Text>{check.name ?? 'check'}</Text>
            )}
          </Text>
        ))}
        <Box flexDirection="row" columnGap={1}>
          <Text bold color="claude">
            💬 {p.threads.length} unresolved review comment{p.threads.length === 1 ? '' : 's'}
          </Text>
          {p.threads.length > 0 ? (
            <Button
              key="send"
              label="Send to Claude"
              onPress={() => sendThreadsToClaude($, p.threads)}
            />
          ) : null}
          <Button key="refresh" label="Refresh" onPress={() => loadPr($)} />
        </Box>
        {p.threads.map((thread, i) => (
          <Box key={`thread-${i}`} flexDirection="column">
            <Text>
              <Link href={thread.url}>
                {thread.path.split('/').pop()}
                {thread.line ? `:${thread.line}` : ''}
              </Link>
              <Text color="subtle"> · {thread.author ?? 'reviewer'}</Text>
            </Text>
            <Markdown text={firstParagraph(thread.body)} />
          </Box>
        ))}
      </Box>
    )
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
    await syncConversation($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const asks = e.reason === 'answer' && (await asksPerson($, e.answer))
      await report($, asks ? 'waiting_permission' : 'waiting_input')
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

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const hint = await next(e)
    const current = await read($, info)
    if (current === null) return hint

    const { Box, Link, Text } = $.ui.resolve(e)
    const diff = current.task_diff ?? current.session_diff
    const isAdhoc = current.task === null
    const ticket = current.linear ? linearId(current.linear) : undefined
    const ticketState = current.linear_state ?? undefined
    const { value: tags } = await $.state.get(moduleTags)

    return (
      <Box flexDirection="column">
        {hint}
        <Box flexDirection="row" flexWrap="wrap">
          <Box
            flexDirection="row"
            flexWrap="wrap"
            columnGap={1}
            borderStyle="round"
            borderColor={PALETTE.border}
            paddingX={1}
          >
            <Pill Text={Text} bg={PALETTE.project} fg={PALETTE.text} bold>
              ⌂ {current.project}
            </Pill>
            <Pill Text={Text} bg={isAdhoc ? PALETTE.adhoc : PALETTE.task} fg={PALETTE.text} bold>
              {isAdhoc ? '✦ adhoc' : `◆ ${current.task}`}
            </Pill>
            <Text color={PALETTE.session} bold>
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
                <Pill
                  Text={Text}
                  bg={prColor(current.pr.state, current.pr.checks)}
                  fg={PALETTE.text}
                  bold
                >
                  {prIcon(current.pr.state, current.pr.checks)} PR {prNumber(current.pr.url)}{' '}
                  {current.pr.state}
                </Pill>
              </Link>
            ) : null}
            {ticket && current.linear ? (
              <Link href={current.linear}>
                <Pill
                  Text={Text}
                  bg={ticketState ? tone(ticketState.color) : PALETTE.linear}
                  fg={PALETTE.text}
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
          {tags?.length ? (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1} paddingY={1}>
              {tags.map(tag => (
                <Text key={tag.label}>
                  <Pill Text={Text} bg={tag.background} fg={tag.text} bold>
                    {tag.label}
                  </Pill>
                  {tag.added > 0 ? <Text color="diffAdded">{` +${tag.added}`}</Text> : null}
                  {tag.removed > 0 ? <Text color="diffRemoved">{` −${tag.removed}`}</Text> : null}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
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

/** The last stretch of an answer, code blocks left out. */
function answerTail(answer: string): string {
  return answer
    .replace(/```[\s\S]*?```/g, '')
    .trim()
    .slice(-800)
}

function reviewLabel(review: string): string {
  switch (review) {
    case 'APPROVED':
      return '✓ approved'
    case 'CHANGES_REQUESTED':
      return '✗ changes requested'
    default:
      return '◷ review required'
  }
}

function reviewColor(review: string): string {
  if (review === 'APPROVED') return PALETTE.ok
  if (review === 'CHANGES_REQUESTED') return PALETTE.bad
  return PALETTE.warn
}

/** A review comment's text without bot footers, badges and HTML. */
function firstParagraph(body: string): string {
  return body
    .split(/\n\s*\n/)
    .filter(part => !/^\s*(\[!\[|<|!\[)/.test(part))
    .slice(0, 2)
    .join('\n\n')
    .trim()
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
      return PALETTE.ok
    case 'waiting_permission':
      return PALETTE.warn
    case 'waiting_input':
      return PALETTE.idle
    default:
      return 'subtle'
  }
}

function prColor(state: string, checks: string | null): string {
  if (state === 'merged') return PALETTE.prMerged
  if (state === 'closed' || checks === 'failing') return PALETTE.prFailing
  if (state === 'draft') return PALETTE.prDraft
  if (checks === 'pending') return PALETTE.prPending
  return PALETTE.prOpen
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

/** A `#rrggbb` color blended a little (22%) toward a dark background. */
function tone(hex: string): string {
  const rgb = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!rgb) return hex
  const base = [0x1f, 0x20, 0x23]
  return (
    '#' +
    rgb
      .slice(1)
      .map((c, i) => Math.round(parseInt(c, 16) * 0.78 + base[i]! * 0.22))
      .map(v => v.toString(16).padStart(2, '0'))
      .join('')
  )
}
