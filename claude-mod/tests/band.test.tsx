import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { PullRequest, SessionInfo, Ticket } from '../types'

const INFO: SessionInfo = {
  project: 'app',
  task: 'fix-auth',
  session: 'main',
  branch: 'fix/auth',
  base_branch: 'main',
  linear: 'https://linear.app/acme/issue/ENG-1',
  task_diff: { added: 12, removed: 3 },
  session_diff: null,
  pr: {
    url: 'https://github.com/acme/app/pull/42',
    state: 'open',
    checks: 'passing',
    review: null,
  },
  siblings: [{ name: '2', agent: 'claude', status: 'running' }],
}

const TICKET: Ticket = {
  identifier: 'ENG-1',
  title: 'Fix the login redirect',
  url: 'https://linear.app/acme/issue/ENG-1',
  description: 'Users land on **/home** instead of where they came from.',
  priorityLabel: 'High',
  state: { name: 'In Progress', color: '#f2c94c', type: 'started' },
  assignee: { displayName: 'ben' },
  creator: { displayName: 'sam' },
  labels: { nodes: [{ name: 'Bug', color: '#eb5757' }] },
  comments: {
    nodes: [
      {
        body: 'Repro on staging.',
        createdAt: '2026-10-01T10:00:00Z',
        user: { displayName: 'sam' },
      },
    ],
  },
}

const PR: PullRequest = {
  number: 42,
  title: 'Fix the login redirect',
  url: 'https://github.com/acme/app/pull/42',
  state: 'open',
  review: 'REVIEW_REQUIRED',
  additions: 12,
  deletions: 3,
  changed_files: 2,
  checks: [
    { name: 'build', state: 'pass', url: null },
    { name: 'e2e', state: 'fail', url: 'https://ci/e2e' },
  ],
  threads: [
    {
      path: 'src/auth/redirect.ts',
      line: 14,
      author: 'sam',
      body: 'This drops the query string.\n\n<sub>bot footer</sub>',
      url: 'https://github.com/acme/app/pull/42#discussion_r1',
    },
  ],
}

const BAND = {
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** A tmux pane in session `tmuxName`; records every `tmux set-environment`. */
function host(on: On, tmuxName: string, envWrites: string[][], info: SessionInfo = INFO) {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('env.get', ($, e) => ({ value: e.name === 'TMUX_PANE' ? '%1' : undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('session.id', () => ({ value: 'conv-1' }))
  on('process.run', ($, e) => {
    const [cmd, sub] = e.argv
    if (cmd === 'tmux' && sub === 'display-message') return ok(`${tmuxName}\n`)
    if (cmd === 'tmux' && sub === 'set-environment') envWrites.push([...e.argv])
    if (cmd === 'showrunner') envWrites.push([...e.argv])
    if (cmd === 'showrunner' && sub === 'session' && e.argv[2] === 'pr') {
      return ok(JSON.stringify(PR))
    }
    if (cmd === 'showrunner' && sub === 'session' && e.argv[2] === 'ticket') {
      return ok(JSON.stringify(TICKET))
    }
    if (cmd === 'showrunner') return ok(JSON.stringify(info))
    return ok('')
  })
}

const start = { cwd: '/w', surface: 'terminal', isInteractive: true } as const

test('showrunner session: reports idle and draws the band', async ($, on) => {
  const writes: string[][] = []
  host(on, 'cm__app__fix-auth__main', writes)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start as any)
  await settle()

  expect(writes).toContainEqual([
    'tmux',
    'set-environment',
    '-t',
    'cm__app__fix-auth__main',
    'CM_STATUS',
    'waiting_input',
  ])
  const ui = await $.ui.mount({ plugin: 'showrunner-mod', surface: 'terminal', ...BAND } as any)
  expect(await ui.find({ type: 'Text', text: /fix-auth/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /app/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PR #42 open/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ENG-1/ })).toBeDefined()
  expect(
    await ui.find({ type: 'Link', href: 'https://github.com/acme/app/pull/42' } as any),
  ).toBeDefined()
  expect(
    await ui.find({ type: 'Link', href: 'https://linear.app/acme/issue/ENG-1' } as any),
  ).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /●/ })).toBeDefined()
  await ui.unmount()
})

test('other tmux sessions: no status, no band', async ($, on) => {
  const writes: string[][] = []
  host(on, 'scratch', writes)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start as any)

  expect(writes.filter(w => w[0] === 'tmux')).toEqual([])
  const ui = await $.ui.mount({ plugin: 'showrunner-mod', surface: 'terminal', ...BAND } as any)
  expect(await ui.find({ type: 'Text', text: /fix-auth/ })).toBeUndefined()
  await ui.unmount()
})

test('a turn reports running, a question waiting_permission, the end waiting_input', async ($, on) => {
  const writes: string[][] = []
  host(on, 'cm__app__fix-auth__main', writes)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'answered' }) as any)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start(start as any)
  await settle()

  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  await $.tool
    .call({ tool: 'AskUserQuestion', input: { questions: [] } } as any)
    .catch(() => undefined)
  await $.turn.complete({
    reason: 'answer',
    answer: 'done',
    durationMs: 5,
    isAborted: false,
    turnId: 't1',
  } as any)
  await settle()

  const statuses = writes.filter(w => w[0] === 'tmux').map(w => w[5])
  expect(statuses).toEqual([
    'waiting_input',
    'running',
    'waiting_permission',
    'running',
    'waiting_input',
  ])
})

test('ticket shows its Linear state; the branch is not shown', async ($, on) => {
  const writes: string[][] = []
  host(on, 'cm__app__ENG-7-fix-auth__main', writes, {
    ...INFO,
    task: 'ENG-7: Fix auth',
    branch: 'eng-7-fix-auth',
    linear: 'https://linear.app/acme/issue/ENG-7/fix-auth',
    linear_state: { name: 'In Review', color: '#f2994a', type: 'started' },
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start as any)
  await settle()

  const ui = await $.ui.mount({ plugin: 'showrunner-mod', surface: 'terminal', ...BAND } as any)
  expect(await ui.find({ type: 'Text', text: /◐ ENG-7 · In Review/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fix-auth$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /⎇/ })).toBeUndefined()
  await ui.unmount()
})

test('ticket id is read from a Linear URL with a title slug', async ($, on) => {
  const writes: string[][] = []
  host(on, 'cm__app__fix-auth__main', writes, {
    ...INFO,
    linear: 'https://linear.app/acme/issue/ENG-9/some-title',
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start as any)
  await settle()

  const ui = await $.ui.mount({ plugin: 'showrunner-mod', surface: 'terminal', ...BAND } as any)
  expect(await ui.find({ type: 'Text', text: /◇ ENG-9/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /some-title/ })).toBeUndefined()
  await ui.unmount()
})

test('/ticket opens a pane with the ticket', async ($, on) => {
  const writes: string[][] = []
  host(on, 'cm__app__fix-auth__main', writes)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start as any)
  await settle()

  const ran = await $.command.run({ command: 'ticket', args: '' } as any)
  expect((ran as any).text).toBe('Opened ENG-1.')
  await settle()

  const ui = await $.ui.mount({
    plugin: 'showrunner-mod',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ticket',
    props: { title: 'ENG-1', isFocused: true, bodyColumns: 72, placement: 'dock' },
  } as any)
  expect(await ui.find({ type: 'Text', text: /ENG-1 · In Progress/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fix the login redirect/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚑ High/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown' } as any)).toBeDefined()
  await ui.unmount()
})

test('records the conversation the session runs', async ($, on) => {
  const writes: string[][] = []
  host(on, 'cm__app__fix-auth__main', writes)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await $.session.start(start as any)
  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  await settle()

  const recorded = writes.filter(w => w[2] === 'set-conversation')
  expect(recorded).toEqual([
    ['showrunner', 'session', 'set-conversation', 'cm__app__fix-auth__main', 'conv-1'],
  ])
})

test('/pr shows checks and review comments; Send to Claude fills the prompt', async ($, on) => {
  const writes: string[][] = []
  const filled: string[] = []
  host(on, 'cm__app__fix-auth__main', writes)
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true } as any
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start as any)
  await settle()

  await $.command.run({ command: 'pr', args: '' } as any)
  await settle()

  const ui = await $.ui.mount({
    plugin: 'showrunner-mod',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pr',
    props: { title: 'PR', isFocused: true, bodyColumns: 80, placement: 'dock' },
  } as any)
  expect(await ui.find({ type: 'Text', text: /PR #42 open/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 failed/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /e2e/ } as any)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 unresolved review comment$/ })).toBeDefined()

  await ui.press({ key: 'send' })
  expect(filled.length).toBe(1)
  expect(filled[0]).toContain('src/auth/redirect.ts:14 (sam): This drops the query string.')
  expect(filled[0]).not.toContain('bot footer')
  await ui.unmount()
})

async function finishTurn($: any, on: On, answer: string, verdict: string, classified: string[]) {
  const writes: string[][] = []
  host(on, 'cm__app__fix-auth__main', writes)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('model.classify', ($, e) => {
    classified.push(e.text)
    return { value: verdict } as any
  })
  await $.session.start(start as any)
  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  await $.turn.complete({
    reason: 'answer',
    answer,
    durationMs: 5,
    isAborted: false,
    turnId: 't1',
  } as any)
  await settle()
  return writes
    .filter(w => w[0] === 'tmux')
    .map(w => w[5])
    .pop()
}

test('an answer ending in questions for the person needs them', async ($, on) => {
  const classified: string[] = []
  const last = await finishTurn(
    $,
    on,
    'Done with the parser.\n\nShould dates be UTC or local? And keep empty rows?',
    'asks',
    classified,
  )
  expect(classified.length).toBe(1)
  expect(last).toBe('waiting_permission')
})

test('a question the model judges rhetorical leaves the session idle', async ($, on) => {
  const classified: string[] = []
  const last = await finishTurn($, on, 'All tests pass. Anything else?', 'done', classified)
  expect(classified.length).toBe(1)
  expect(last).toBe('waiting_input')
})

test('a ? only inside code is not checked', async ($, on) => {
  const classified: string[] = []
  const last = await finishTurn(
    $,
    on,
    'Fixed:\n```ts\nconst x = a ? b : c\n```\nDone.',
    'asks',
    classified,
  )
  expect(classified.length).toBe(0)
  expect(last).toBe('waiting_input')
})
