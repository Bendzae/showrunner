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
  linear_state?: { name: string; color: string; type: string } | null
  task_diff?: Diff | null
  session_diff: Diff | null
  pr?: { url: string; state: string; checks: string | null; review: string | null } | null
  siblings: Sibling[]
}

declare module 'claude-code' {
  interface PluginState {
    'showrunner-mod': { info: SessionInfo | null }
  }
}
