import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { startSessionDrag } from '@/app/chat/session-drag'
import { registry } from '@/contrib/registry'
import type * as HermesModule from '@/hermes'
import type { SessionInfo } from '@/hermes'
import { SESSION_ROW_AREAS, type SessionRowSlotProps } from '@/lib/session-row-slots'
import type * as SessionStore from '@/store/session'
import type * as SessionStatesStore from '@/store/session-states'

import { SidebarSessionRow } from './session-row'

afterEach(cleanup)

// Exercises the REAL row (no row stub) so a contributed button that bubbles
// into the row's resume onClick, or that arms the session drag on pointerdown,
// fails here — the same real-path discipline as session-row-actions.test.tsx
// (#85163) and session-row-rename-drag.test.tsx.

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel', close: 'Close', delete: 'Delete', save: 'Save' },
      assistant: {
        thread: {
          today: (time: string) => `Today, ${time}`,
          yesterday: (time: string) => `Yesterday, ${time}`
        }
      },
      sidebar: {
        messageCount: (count: number) => `${count} messages`,
        toolCallCount: (count: number) => `${count} tool calls`,
        projects: {
          menuAppearance: 'Appearance',
          moveFailed: 'Could not move session',
          moveNoProjects: 'No other projects',
          movedTo: (name: string) => `Moved to ${name}`,
          moveToProject: 'Move to project',
          noColor: 'No color'
        },
        row: {
          ageMin: 'm',
          ageNow: 'now',
          archive: 'Archive',
          backgroundRunning: 'Running in background',
          branchFrom: 'Branch from here',
          copyId: 'Copy ID',
          copyIdFailed: 'Failed to copy ID',
          deleteDesc: (title: string) => `Delete ${title}?`,
          deleteTitle: 'Delete session?',
          deleting: 'Deleting…',
          deleted: 'Session deleted',
          export: 'Export',
          finishedUnread: 'Finished',
          handoffOrigin: (platform: string) => `Started on ${platform}`,
          hideTabBar: 'Hide tab bar',
          messageCount: (count: number) => `${count} messages`,
          needsInput: 'Needs input',
          pin: 'Pin',
          rename: 'Rename',
          renameDesc: 'Leave empty to clear.',
          renameFailed: 'Rename failed',
          renameTitle: 'Rename session',
          renamed: 'Renamed',
          sessionActions: 'Session actions',
          sessionRunning: 'Running',
          unpin: 'Unpin',
          untitledPlaceholder: 'Untitled',
          waitingForAnswer: 'Waiting for answer'
        }
      },
      zones: { closeAll: 'Close all', closeOthers: 'Close others', closeToRight: 'Close to the right' }
    }
  })
}))
vi.mock('@/app/chat/profile-tag', () => ({ ProfileTag: () => null }))
vi.mock('@/app/chat/session-drag', () => ({ startSessionDrag: vi.fn() }))
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesModule>()),
  renameSession: vi.fn(),
  setSessionUnreadRemote: vi.fn(() => Promise.resolve({ ok: true }))
}))
vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn() }))
vi.mock('@/lib/session-source', () => ({
  handoffOriginSource: () => null,
  sessionSourceLabel: () => ''
}))
vi.mock('@/lib/session-export', () => ({ exportSession: vi.fn() }))
vi.mock('@/lib/time', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coarseElapsed: () => ({ unit: 'minute' as const, value: 5 })
}))
vi.mock('@/lib/profile-color', () => ({ PROFILE_SWATCHES: [] }))
vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activeGateway: vi.fn(() => null)
}))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/projects', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  moveSessionToProject: vi.fn(),
  projectIdForCwd: vi.fn(() => null),
  projectRootCwd: vi.fn(() => '')
}))
vi.mock('@/store/session', async importOriginal => {
  const actual = await importOriginal<typeof SessionStore>()

  return { ...actual, $unreadFinishedSessionIds: atom<string[]>([]) }
})
vi.mock('@/store/session-states', async importOriginal => {
  const actual = await importOriginal<typeof SessionStatesStore>()

  return { ...actual, openSessionTile: vi.fn() }
})
vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  canOpenSessionWindow: () => false,
  openSessionInNewWindow: vi.fn()
}))
vi.mock('./use-profile-prewarm', () => ({
  useProfilePrewarm: () => ({ cancelPrewarm: vi.fn(), notePointerMove: vi.fn(), startPrewarm: vi.fn() })
}))

const mockDrag = vi.mocked(startSessionDrag)

const baseSession = {
  cwd: '/tmp/project',
  handoff_platform: null,
  handoff_state: null,
  id: 's1',
  last_active: 0,
  message_count: 1,
  profile: 'default',
  started_at: 0,
  title: 'Takeover row'
} as SessionInfo

const renderRow = (session: SessionInfo, extra?: { card?: boolean; onResume?: () => void }) => {
  const onResume = extra?.onResume ?? vi.fn()

  const result = render(
    <SidebarSessionRow
      card={extra?.card}
      isPinned={false}
      isSelected={false}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      onPin={vi.fn()}
      onResume={onResume}
      onToggleUnread={vi.fn()}
      session={session}
      unread={false}
    />
  )

  return { ...result, onResume }
}

// Row-action slot: a plugin contributes a BUTTON through the registry, and the
// row mounts it inside its gesture-safe actions cluster — the seam the
// Infinite Chat layer's takeover / hand-back buttons need (one tap each,
// never a typed command). The contract under test: a plain onClick on the
// contributed button runs the button's own handler and NOTHING else the row
// owns — no resume, no session drag.
describe('SidebarSessionRow actions slot (sessionRow.actions)', () => {
  const disposers: Array<() => void> = []

  afterEach(() => {
    disposers.splice(0).forEach(dispose => dispose())
    mockDrag.mockClear()
  })

  const contributeAction = (id: string, label: string, onAction?: () => void) =>
    disposers.push(
      registry.register({
        area: SESSION_ROW_AREAS.actions,
        data: {
          render: ({ sessionId }: SessionRowSlotProps) => (
            <button data-session-id={sessionId} data-testid={`action-${id}`} onClick={onAction} type="button">
              {label}
            </button>
          )
        },
        id,
        source: 'disk'
      })
    )

  it('mounts the contributed button inside the actions cluster, handed the DURABLE row id', () => {
    act(() => {
      contributeAction('takeover', 'Take over')
    })

    // Auto-compression rotates the live id; the slot hands the lineage root,
    // the id the layer's registry keys on — same guarantee as the decoration
    // slots.
    renderRow({ ...baseSession, _lineage_root_id: 'root-9', id: 'live-9' } as SessionInfo)

    const button = screen.getByTestId('action-takeover')

    expect(button.textContent).toBe('Take over')
    expect(button.getAttribute('data-session-id')).toBe('root-9')
    // Inside the gesture-safe cluster, not the row body: the cluster is what
    // owns the click/pointerdown gate.
    expect(button.closest('[data-row-actions]')).not.toBeNull()
  })

  it('a contributed action click runs its own handler and does not resume the row', () => {
    const onAction = vi.fn()

    act(() => {
      contributeAction('takeover', 'Take over', onAction)
    })

    const { onResume } = renderRow(baseSession)

    fireEvent.click(screen.getByTestId('action-takeover'))

    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onResume).not.toHaveBeenCalled()
  })

  it('a press on the contributed action does not arm a session drag', () => {
    act(() => {
      contributeAction('takeover', 'Take over')
    })

    renderRow(baseSession)

    const button = screen.getByTestId('action-takeover')

    fireEvent.pointerDown(button, {
      button: 0,
      clientX: 20,
      clientY: 20,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse'
    })

    expect(mockDrag).not.toHaveBeenCalled()
  })

  it('control: a press on the row body still arms the drag, so the test above can detect arming', async () => {
    const { container } = renderRow(baseSession)
    const doc = container.ownerDocument
    const title = screen.getByText('Takeover row').closest('button')!

    fireEvent.pointerDown(title, {
      button: 0,
      clientX: 20,
      clientY: 20,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse'
    })
    await act(async () => {
      fireEvent.pointerMove(doc, { clientX: 80, clientY: 20, isPrimary: true, pointerId: 1 })
      await new Promise(resolve => setTimeout(resolve, 48))
    })

    expect(mockDrag).toHaveBeenCalledTimes(1)

    fireEvent.pointerUp(doc, { clientX: 80, clientY: 20, isPrimary: true, pointerId: 1 })
  })

  it('the same button works in the card (Inbox) row without resuming it', () => {
    const onAction = vi.fn()

    act(() => {
      contributeAction('hand-back', 'Hand back', onAction)
    })

    const { onResume } = renderRow(baseSession, { card: true })

    fireEvent.click(screen.getByTestId('action-hand-back'))

    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onResume).not.toHaveBeenCalled()
  })

  it('renders nothing for the actions area with no registrations', () => {
    const { container } = renderRow(baseSession)

    expect(container.querySelector('[data-testid^="action-"]')).toBeNull()
    expect(screen.getByText('Takeover row')).not.toBeNull()
  })
})
