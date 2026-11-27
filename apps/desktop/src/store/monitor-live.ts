import { atom } from 'nanostores'

/**
 * The monitor snapshot's `live` section, as the quota plugin publishes it.
 *
 * One source for "open now": the quota view's Live tab, the nav badge and the
 * sidebar's Open-now section all render this same snapshot — the plugin is the
 * single fetcher (`quota monitor snapshot --json`), the host only holds what
 * the plugin last published. The shape mirrors
 * `quota_monitor/live.py::live()` in the quota plugin: `running` rows plus the
 * `counts` object the Live tab renders. `card_only` rows (kanban work with no
 * matched session) carry no session id in any `state.db` — they are
 * display-only, never resumable.
 *
 * The plugin publishes through `host.publishMonitorLive` (see `sdk/index.ts`).
 * Until the plugin's publish leg lands, this atom stays null and the sidebar
 * says so in plain words instead of showing a fake zero.
 */

/** One row of `live.running`. Only the fields the sidebar renders are kept. */
export interface MonitorLiveRow {
  /** Session id for real sessions; the kanban card id for `card_only` rows. */
  id: string
  profile: string
  title: string
  model: string | null
  /** `working` | `needs_approval` | `waiting` | `stalled` | `ended` | … */
  state: string
  status: string
  subagent: boolean
  /** `desktop` | `cli` | `tui` | `kanban` | `claude-code` | `copilot-cli` | … */
  origin: string
  /** `hermes` | `claude-code` | `copilot-cli` | … */
  kind: string
  /** Display name for the row's source (`Hermes`, `Claude Code`, …). */
  sourceName: string
  /** True for kanban-only rows: no session id, display-only. */
  cardOnly: boolean
  /** The kanban card behind a `card_only` row; null for real sessions. */
  kanban: {
    id: string
    board: string
    status: string
    title: string
    blockKind: string | null
  } | null
  /** Unix seconds of the row's last activity, or null. */
  last: number | null
}

export interface MonitorLiveCounts {
  open: number
  working: number
  needsApproval: number
  yourTurn: number
  stalled: number
  subagents: number
}

export interface MonitorLiveSection {
  /** Unix seconds the snapshot was taken (`live.now`). */
  now: number
  running: MonitorLiveRow[]
  counts: MonitorLiveCounts
}

/** What the plugin hands the host on every snapshot poll. */
export interface MonitorLiveSnapshot {
  /** Scope profile the snapshot was taken for — named, never merged. */
  profile: string
  live: MonitorLiveSection
  /** Unix seconds the snapshot arrived (`snapshot.generated_at`). */
  fetchedAt: number
}

/** A session counts as running while it wrote within this window (`live.py: ACTIVE_WINDOW`). */
export const MONITOR_LIVE_ACTIVE_WINDOW_SECONDS = 600

/** Past this age a published snapshot is last-known, never fresh truth. */
export const MONITOR_LIVE_STALE_AFTER_SECONDS = 900

/** Upper bound on stored rows: the sidebar renders the open mains only. */
const MONITOR_LIVE_MAX_ROWS = 500

/** The last published snapshot, or null when the plugin has not published yet. */
export const $monitorLive = atom<MonitorLiveSnapshot | null>(null)

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asCount(value: unknown): number {
  const n = asNumber(value)

  return n === null || n < 0 ? 0 : Math.floor(n)
}

function asRow(value: unknown): MonitorLiveRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>
  const id = asNonEmptyString(row.id)

  if (id === null) {
    return null
  }

  const kanbanRaw = row.kanban

  const kanban =
    kanbanRaw && typeof kanbanRaw === 'object' && !Array.isArray(kanbanRaw)
      ? {
          id: asNonEmptyString((kanbanRaw as Record<string, unknown>).id) ?? id,
          board: asNonEmptyString((kanbanRaw as Record<string, unknown>).board) ?? '',
          status: asNonEmptyString((kanbanRaw as Record<string, unknown>).status) ?? '',
          title: asNonEmptyString((kanbanRaw as Record<string, unknown>).title) ?? '',
          blockKind: asNonEmptyString((kanbanRaw as Record<string, unknown>).block_kind)
        }
      : null

  return {
    id,
    profile: asNonEmptyString(row.profile) ?? '',
    title: asNonEmptyString(row.title) ?? id,
    model: asNonEmptyString(row.model),
    state: asNonEmptyString(row.state) ?? 'working',
    status: asNonEmptyString(row.status) ?? 'ended',
    subagent: row.subagent === true,
    origin: asNonEmptyString(row.origin) ?? '',
    kind: asNonEmptyString(row.kind) ?? 'hermes',
    sourceName: asNonEmptyString(row.source_name) ?? asNonEmptyString(row.kind) ?? 'hermes',
    cardOnly: row.card_only === true,
    kanban,
    last: asNumber(row.last)
  }
}

function asCounts(running: MonitorLiveRow[], value: unknown): MonitorLiveCounts {
  // The Live tab's numbers, from the same object — never recomputed from a
  // different store. A missing or malformed counts block falls back to the
  // rows in hand, so the header never shows a fake zero.
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  const mains = running.filter(row => row.status === 'running' && !row.subagent)

  if (raw === null) {
    return {
      open: mains.length,
      working: mains.filter(row => row.state === 'working').length,
      needsApproval: mains.filter(row => row.state === 'needs_approval').length,
      yourTurn: mains.filter(row => row.state === 'waiting').length,
      stalled: mains.filter(row => row.state === 'stalled').length,
      subagents: running.filter(row => row.status === 'running' && row.subagent).length
    }
  }

  return {
    open: asCount(raw.open),
    working: asCount(raw.working),
    needsApproval: asCount(raw.needs_approval),
    yourTurn: asCount(raw.your_turn),
    stalled: asCount(raw.stalled),
    subagents: asCount(raw.subagents)
  }
}

/** The rows the Live tab renders as open: mains only, never subagents or ended rows. */
export function openNowRows(live: MonitorLiveSection): MonitorLiveRow[] {
  return live.running.filter(row => row.status === 'running' && !row.subagent)
}

/** A row the sidebar may resume: a real Hermes session with a session id. */
export function isResumableLiveRow(row: MonitorLiveRow): boolean {
  return row.kind === 'hermes' && !row.cardOnly && row.kanban === null
}

/** A row that is board work, not a chat session — display-only by definition. */
export function isBoardWorkRow(row: MonitorLiveRow): boolean {
  return row.cardOnly || row.kanban !== null || row.origin === 'kanban'
}

function asSnapshot(input: unknown): MonitorLiveSnapshot | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }

  const raw = input as Record<string, unknown>
  const profile = asNonEmptyString(raw.profile)

  if (profile === null) {
    return null
  }

  const liveRaw = raw.live

  if (!liveRaw || typeof liveRaw !== 'object' || Array.isArray(liveRaw)) {
    return null
  }

  const live = liveRaw as Record<string, unknown>
  const runningRaw = live.running

  if (!Array.isArray(runningRaw)) {
    return null
  }

  const running: MonitorLiveRow[] = []

  for (const entry of runningRaw) {
    const row = asRow(entry)

    if (row !== null) {
      running.push(row)
    }

    if (running.length >= MONITOR_LIVE_MAX_ROWS) {
      break
    }
  }

  const fetchedAt = asNumber(raw.fetchedAt) ?? Date.now() / 1000

  return {
    profile,
    live: {
      now: asNumber(live.now) ?? fetchedAt,
      running,
      counts: asCounts(running, live.counts)
    },
    fetchedAt
  }
}

/**
 * Publish a fresh monitor snapshot. Returns false — and keeps the previous
 * snapshot — when the payload is malformed, so one bad publish can never
 * blank the sidebar's live list. The plugin calls this on every snapshot
 * poll; the sidebar renders whatever is here.
 */
export function publishMonitorLive(input: unknown): boolean {
  const snapshot = asSnapshot(input)

  if (snapshot === null) {
    return false
  }

  $monitorLive.set(snapshot)

  return true
}

/** Drop the published snapshot (tests; plugin unload). */
export function clearMonitorLive(): void {
  $monitorLive.set(null)
}
