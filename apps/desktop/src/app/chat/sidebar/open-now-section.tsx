import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { SidebarGroup, SidebarGroupContent } from '@/components/ui/sidebar'
import { useI18n } from '@/i18n'
import {
  $monitorLive,
  isBoardWorkRow,
  isResumableLiveRow,
  MONITOR_LIVE_ACTIVE_WINDOW_SECONDS,
  MONITOR_LIVE_STALE_AFTER_SECONDS,
  type MonitorLiveRow,
  openNowRows
} from '@/store/monitor-live'

import { SidebarSectionHeader } from './sessions-section'

/**
 * "Open now" — the sidebar's read of the ONE live source: the monitor
 * snapshot's `live` section, as the quota plugin publishes it through
 * `host.publishMonitorLive`. The Live tab, the nav badge and this section all
 * render the same snapshot, so they agree by construction.
 *
 * Row kinds are derived from the row, never hard-coded:
 *  - a real Hermes session resumes through `onResumeSession` (its `id` is the
 *    stored session id);
 *  - board work (`card_only` rows) has no session id in any `state.db`, so it
 *    is display-only — no resume action, ever;
 *  - CLI rows (Claude Code, Copilot) are display-only too: their ids are not
 *    Hermes session ids.
 *
 * The snapshot is display-only when it goes stale, and the section says so in
 * plain words instead of showing a fake zero — the same rule as the quota
 * views. Before the plugin publishes anything, the section says the live list
 * has not been shared yet.
 */

interface OpenNowSectionProps {
  onResumeSession: (sessionId: string) => void
}

function OpenNowRow({
  row,
  sub,
  onResumeSession
}: {
  row: MonitorLiveRow
  sub: string
  onResumeSession: (sessionId: string) => void
}) {
  const title = (
    <>
      <span className="block truncate text-sm">{row.title}</span>
      <span className="block truncate text-xs text-(--ui-text-tertiary)">{sub}</span>
    </>
  )

  if (isResumableLiveRow(row)) {
    return (
      <button
        className="block w-full rounded-lg px-2 py-1 text-left hover:bg-(--ui-control-active-background)"
        onClick={() => onResumeSession(row.id)}
        title={row.title}
        type="button"
      >
        {title}
      </button>
    )
  }

  return (
    <div className="block w-full rounded-lg px-2 py-1 text-left" title={row.title}>
      {title}
    </div>
  )
}

export function OpenNowSection({ onResumeSession }: OpenNowSectionProps) {
  const { t } = useI18n()
  const snapshot = useStore($monitorLive)
  const [open, setOpen] = useState(true)

  const s = t.sidebar.openNow
  const rows = snapshot ? openNowRows(snapshot.live) : []

  const stale =
    snapshot !== null && Date.now() / 1000 - snapshot.fetchedAt > MONITOR_LIVE_STALE_AFTER_SECONDS

  const fetchedTime = snapshot
    ? new Date(snapshot.fetchedAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null

  return (
    <SidebarGroup className="shrink-0 p-0 pb-1">
      <SidebarSectionHeader
        label={s.label}
        meta={snapshot ? String(snapshot.live.counts.open) : undefined}
        onToggle={() => setOpen(!open)}
        open={open}
      />
      {open && (
        <SidebarGroupContent className="flex flex-col gap-px pb-1.75 pt-1">
          {snapshot === null ? (
            <div className="grid min-h-16 place-items-center rounded-lg px-2 text-center text-xs text-(--ui-text-tertiary)">
              {s.unavailable}
            </div>
          ) : (
            <>
              <div className="px-2 text-xs text-(--ui-text-tertiary)">{s.scope(snapshot.profile)}</div>
              <div className="px-2 pb-1 text-xs text-(--ui-text-tertiary)">
                {s.window(MONITOR_LIVE_ACTIVE_WINDOW_SECONDS / 60)}
              </div>
              {stale && fetchedTime !== null && (
                <div className="rounded-lg px-2 py-1 text-xs text-(--ui-text-tertiary)">
                  {s.stale(fetchedTime)}
                </div>
              )}
              {rows.length === 0 ? (
                <div className="grid min-h-16 place-items-center rounded-lg px-2 text-center text-xs text-(--ui-text-tertiary)">
                  {s.empty}
                </div>
              ) : (
                rows.map(row => (
                  <OpenNowRow
                    key={`${row.profile}::${row.id}`}
                    onResumeSession={onResumeSession}
                    row={row}
                    sub={
                      isBoardWorkRow(row)
                        ? s.boardWork
                        : row.kind === 'hermes'
                          ? s.session(row.state)
                          : `${row.sourceName} · ${row.state}`
                    }
                  />
                ))
              )}
            </>
          )}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  )
}
