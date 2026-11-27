// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearMonitorLive, publishMonitorLive } from '@/store/monitor-live'

import { OpenNowSection } from './open-now-section'

afterEach(cleanup)

afterEach(() => {
  clearMonitorLive()
})

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      sidebar: {
        openNow: {
          label: 'Open now',
          scope: (profile: string) => `Showing the ${profile} profile's open work`,
          window: (minutes: number) => `Active in the last ${minutes} minutes`,
          boardWork: 'Board work · running',
          session: (state: string) => `Session · ${state}`,
          unavailable: "The quota view hasn't shared its live list yet.",
          stale: (time: string) => `Showing ${time}'s list — the live list hasn't updated.`,
          empty: 'Nothing open right now'
        }
      }
    }
  })
}))

const nowSeconds = () => Date.now() / 1000

function livePayload(overrides: Record<string, unknown> = {}) {
  return {
    profile: 'default',
    live: {
      now: nowSeconds(),
      running: [
        {
          id: 'sess-one',
          profile: 'default',
          title: 'Alpha chat',
          model: 'model-a',
          state: 'working',
          status: 'running',
          subagent: false,
          origin: 'desktop',
          kind: 'hermes',
          source_name: 'Hermes',
          card_only: false,
          kanban: null,
          last: nowSeconds()
        },
        {
          id: 't_c63fe524',
          profile: 'musti',
          title: 'Board card work',
          model: null,
          state: 'working',
          status: 'running',
          subagent: false,
          origin: 'kanban',
          kind: 'hermes',
          source_name: 'Hermes',
          card_only: true,
          kanban: { id: 't_c63fe524', board: 'default', status: 'running', title: 'Board card work', block_kind: null },
          last: nowSeconds()
        },
        {
          id: 'cli-one',
          profile: 'claude-code',
          title: 'CLI session',
          model: 'claude-opus',
          state: 'working',
          status: 'running',
          subagent: false,
          origin: 'claude-code',
          kind: 'claude-code',
          source_name: 'Claude Code',
          card_only: false,
          kanban: null,
          last: nowSeconds()
        },
        {
          id: 'sess-sub',
          profile: 'default',
          title: 'A subagent',
          model: 'model-a',
          state: 'working',
          status: 'running',
          subagent: true,
          origin: 'desktop',
          kind: 'hermes',
          source_name: 'Hermes',
          card_only: false,
          kanban: null,
          last: nowSeconds()
        },
        {
          id: 'sess-ended',
          profile: 'default',
          title: 'An ended chat',
          model: 'model-a',
          state: 'ended',
          status: 'ended',
          subagent: false,
          origin: 'desktop',
          kind: 'hermes',
          source_name: 'Hermes',
          card_only: false,
          kanban: null,
          last: nowSeconds()
        }
      ],
      counts: { open: 3, working: 3, needs_approval: 0, your_turn: 0, stalled: 0, subagents: 1 }
    },
    fetchedAt: nowSeconds(),
    ...overrides
  }
}

describe('OpenNowSection', () => {
  beforeEach(() => {
    expect(publishMonitorLive(livePayload())).toBe(true)
  })

  it('renders live rows from the published snapshot with kind labels', () => {
    render(<OpenNowSection onResumeSession={() => {}} />)

    expect(screen.getByText('Open now')).toBeTruthy()
    expect(screen.getByText('Alpha chat')).toBeTruthy()
    expect(screen.getByText('Session · working')).toBeTruthy()
    expect(screen.getByText('Board card work')).toBeTruthy()
    expect(screen.getByText('Board work · running')).toBeTruthy()
    expect(screen.getByText('CLI session')).toBeTruthy()
    expect(screen.getByText('Claude Code · working')).toBeTruthy()
  })

  it('shows the snapshot count from live.counts.open in the header', () => {
    render(<OpenNowSection onResumeSession={() => {}} />)

    // The header meta is the Live tab's own number — one source, not a recount.
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('names the snapshot profile and the activity window', () => {
    render(<OpenNowSection onResumeSession={() => {}} />)

    expect(screen.getByText("Showing the default profile's open work")).toBeTruthy()
    expect(screen.getByText('Active in the last 10 minutes')).toBeTruthy()
  })

  it('leaves subagents and ended rows out of the open list', () => {
    render(<OpenNowSection onResumeSession={() => {}} />)

    expect(screen.queryByText('A subagent')).toBeNull()
    expect(screen.queryByText('An ended chat')).toBeNull()
  })

  it('resumes a real session and never wires a board-work row to resume', () => {
    const onResumeSession = vi.fn()
    render(<OpenNowSection onResumeSession={onResumeSession} />)

    fireEvent.click(screen.getByRole('button', { name: /Alpha chat/ }))
    expect(onResumeSession).toHaveBeenCalledOnce()
    expect(onResumeSession).toHaveBeenCalledWith('sess-one')

    // Board work has no session id in any state.db: it renders as plain text,
    // never as a button, so there is no resume action to misfire.
    expect(screen.queryByRole('button', { name: /Board card work/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /CLI session/ })).toBeNull()
  })

  it('says so in plain words when the plugin has not published yet', () => {
    clearMonitorLive()
    render(<OpenNowSection onResumeSession={() => {}} />)

    expect(screen.getByText("The quota view hasn't shared its live list yet.")).toBeTruthy()
    expect(screen.queryByText('Alpha chat')).toBeNull()
  })

  it('keeps showing the last-known list, labelled stale, when the snapshot ages', () => {
    expect(publishMonitorLive(livePayload({ fetchedAt: nowSeconds() - 3600 }))).toBe(true)
    render(<OpenNowSection onResumeSession={() => {}} />)

    expect(screen.getByText(/hasn't updated/)).toBeTruthy()
    expect(screen.getByText('Alpha chat')).toBeTruthy()
  })

  it('says so when the snapshot is fresh but nothing is open', () => {
    expect(publishMonitorLive(livePayload({ live: { now: nowSeconds(), running: [], counts: { open: 0, working: 0, needs_approval: 0, your_turn: 0, stalled: 0, subagents: 0 } } }))).toBe(true)
    render(<OpenNowSection onResumeSession={() => {}} />)

    expect(screen.getByText('Nothing open right now')).toBeTruthy()
  })

  it('keeps the previous snapshot when a malformed publish arrives', () => {
    expect(publishMonitorLive({ profile: 'default' })).toBe(false)
    render(<OpenNowSection onResumeSession={() => {}} />)

    expect(screen.getByText('Alpha chat')).toBeTruthy()
  })
})
