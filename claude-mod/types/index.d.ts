export type Status = 'running' | 'waiting_input' | 'waiting_permission'

export type Diff = { added: number; removed: number }

export type Sibling = { name: string; agent: string; status: Status | null }

export type SessionInfo = {
  project: string
  task: string | null
  session: string
  branch: string | null
  base_branch?: string
  linear?: string | null
  linear_state?: TicketState | null
  task_diff?: Diff | null
  session_diff: Diff | null
  pr?: { url: string; state: string; checks: string | null; review: string | null } | null
  siblings: Sibling[]
}

export type TicketState = { name: string; color: string; type: string }

export type Ticket = {
  identifier: string
  title: string
  url: string
  description: string | null
  priorityLabel: string
  state: TicketState
  assignee: { displayName: string } | null
  creator: { displayName: string } | null
  labels: { nodes: { name: string; color: string }[] }
  comments: { nodes: { body: string; createdAt: string; user: { displayName: string } | null }[] }
}

export type Check = {
  name: string | null
  state: 'pass' | 'fail' | 'pending' | 'skipped'
  url: string | null
}

export type Thread = {
  path: string
  line: number | null
  author: string | null
  body: string
  url: string
}

export type PullRequest = {
  number: number
  title: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  review: string | null
  additions: number
  deletions: number
  changed_files: number
  checks: Check[]
  threads: Thread[]
}

export type Loaded<T> =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T }

export type TicketView =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; ticket: Ticket }

/** Tags the monorepo-touched mod publishes, drawn beside the band. */
export type ModuleTag = { label: string; background: string; text: string; added: number; removed: number }

declare module 'claude-code' {
  interface PluginState {
    'showrunner-mod': {
      info: SessionInfo | null
      ticket: TicketView | null
      pr: Loaded<PullRequest> | null
    }
    'monorepo-touched': { tags: ModuleTag[] | null }
  }
}
