import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SessionInfo } from '../types'

const INFO: SessionInfo = {
  project: 'app',
  task: 'fix-auth',
  session: 'main',
  branch: 'fix/auth',
  base_branch: 'main',
  linear: 'https://linear.app/acme/issue/ENG-1',
  task_diff: { added: 12, removed: 3 },
  session_diff: null,
  pr: { url: 'https://github.com/acme/app/pull/42', state: 'open', checks: 'passing', review: null },
  siblings: [{ name: '2', agent: 'claude', status: 'running' }],
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { top: 0 } },
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
  on('process.run', ($, e) => {
    const [cmd, sub] = e.argv
    if (cmd === 'tmux' && sub === 'display-message') return ok(`${tmuxName}\n`)
    if (cmd === 'tmux' && sub === 'set-environment') envWrites.push([...e.argv])
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

  expect(writes).toContainEqual(['tmux', 'set-environment', '-t', 'cm__app__fix-auth__main', 'CM_STATUS', 'waiting_input'])
  const ui = await $.ui.mount({ plugin: 'showrunner-mod', surface: 'terminal', ...BAND } as any)
  expect(await ui.find({ type: 'Text', text: /fix-auth/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /app/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PR #42 open/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ENG-1/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', href: 'https://github.com/acme/app/pull/42' } as any)).toBeDefined()
  expect(await ui.find({ type: 'Link', href: 'https://linear.app/acme/issue/ENG-1' } as any)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /●/ })).toBeDefined()
  await ui.unmount()
})

test('other tmux sessions: no status, no band', async ($, on) => {
  const writes: string[][] = []
  host(on, 'scratch', writes)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start as any)

  expect(writes).toEqual([])
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
  await $.tool.call({ tool: 'AskUserQuestion', input: { questions: [] } } as any).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 5, isAborted: false, turnId: 't1' } as any)
  await settle()

  const statuses = writes.map(w => w[5])
  expect(statuses).toEqual(['waiting_input', 'running', 'waiting_permission', 'running', 'waiting_input'])
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
