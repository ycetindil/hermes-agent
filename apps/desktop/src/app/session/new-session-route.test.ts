import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { desktopSessionCreateParams } from '@/app/session/hooks/use-session-actions/session-create-request'
import { defaultNewSessionTarget, prepareDefaultNewSession } from '@/app/session/new-session-route'
import { $defaultProfileRoute } from '@/store/default-profile'
import {
  $activeGatewayProfile,
  $newChatProfile,
  $newChatRoute,
  captureNewChatSource,
  selectProfile
} from '@/store/profile'
import { $profileSwitchPending } from '@/store/profile-switch-state'

// A rail pick must survive a generic New Session gesture: the next
// session.create has to carry the selected profile, not the window's saved
// boot default and not the live gateway, which still lags the swap
// (t_181c2e0c — the owner switched to `hurmuz` and the next chat still
// opened on the empty `default` profile).

const { ensureGatewayForProfile } = vi.hoisted(() => ({
  ensureGatewayForProfile: vi.fn(async (_profile: string): Promise<undefined> => undefined)
}))

vi.mock('@/store/gateway', () => ({
  $gateway: atom<unknown>({ connectionState: 'open' }),
  activeGatewayConnectionId: () => null,
  activeGatewayProfileKey: () => ensureGatewayForProfile.mock.lastCall?.[0] ?? 'default',
  ensureGatewayForAgent: vi.fn(),
  ensureGatewayForProfile,
  openGatewayForAgent: vi.fn(),
  openGatewayForProfile: vi.fn(),
  requestGatewayForAgent: vi.fn()
}))
vi.mock('@/hermes', () => ({
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  setApiRequestProfile: vi.fn()
}))
vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))
vi.mock('@/store/starmap', () => ({ reloadOpenStarmapGraph: vi.fn(), resetStarmapGraph: vi.fn() }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

beforeEach(() => {
  ensureGatewayForProfile.mockClear()
  ensureGatewayForProfile.mockImplementation(async () => undefined)
  $activeGatewayProfile.set('default')
  $newChatProfile.set(null)
  $newChatRoute.set(null)
  captureNewChatSource(null)
  $profileSwitchPending.set(null)
  $defaultProfileRoute.set(null)
  // No Electron bridge: the legacy profile door resolves locally, and the
  // window's own location (jsdom) answers the peer-window checks.
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
})

describe('rail pick survives a generic New Session', () => {
  it('a pick still settling keeps the next create on the pick, not the saved default', async () => {
    $defaultProfileRoute.set({ connectionId: null, profile: 'default' })

    // Hold the swap in flight: the live gateway still reads `default`.
    const activation = Promise.withResolvers<undefined>()
    ensureGatewayForProfile.mockReturnValueOnce(activation.promise)

    try {
      selectProfile('hurmuz')
      expect($newChatProfile.get()).toBe('hurmuz')
      expect($profileSwitchPending.get()).toBe('hurmuz')
      expect($activeGatewayProfile.get()).toBe('default')

      // The generic New Session gesture, as the sidebar performs it: the pin is
      // dropped, the default new session is prepared, and a fresh draft starts.
      // While the swap is still settling the create cannot run yet — the
      // gateway serialises it behind the swap — so the assertion here is the
      // state the create will resolve from: the pending pick still stands,
      // the saved default was not re-pinned, and no default target was taken.
      $newChatProfile.set(null)
      prepareDefaultNewSession()

      expect($profileSwitchPending.get()).toBe('hurmuz')
      expect($newChatProfile.get()).toBeNull()
      expect(defaultNewSessionTarget()).toBeNull()

      // Let the swap land, then the next create carries the pick.
      activation.resolve(undefined)
      await vi.waitFor(() => expect($profileSwitchPending.get()).toBeNull())
      expect($activeGatewayProfile.get()).toBe('hurmuz')

      const params = await desktopSessionCreateParams('')
      expect(params.profile).toBe('hurmuz')
      expect(ensureGatewayForProfile).not.toHaveBeenCalledWith('default', expect.anything())
    } finally {
      // Never leak a held swap into the next case: a failed assertion above
      // must not leave the gateway serialised behind this pick.
      activation.resolve(undefined)
      await vi.waitFor(() => expect($profileSwitchPending.get()).toBeNull()).catch(() => undefined)
    }
  })

  it('a settled pick survives a generic New Session even with a saved default', async () => {
    $defaultProfileRoute.set({ connectionId: null, profile: 'default' })

    selectProfile('hurmuz')
    await vi.waitFor(() => expect($profileSwitchPending.get()).toBeNull())
    // The swap has landed: the live gateway is on the pick (the activation
    // publishes it itself; assert the state the test then relies on).
    expect($activeGatewayProfile.get()).toBe('hurmuz')
    expect($newChatProfile.get()).toBe('hurmuz')

    prepareDefaultNewSession()

    expect($newChatProfile.get()).toBe('hurmuz')
    const params = await desktopSessionCreateParams('')
    expect(params.profile).toBe('hurmuz')
    expect(ensureGatewayForProfile).not.toHaveBeenCalledWith('default', expect.anything())
  })

  it('with no live selection, a generic New Session still takes the saved default', async () => {
    $defaultProfileRoute.set({ connectionId: null, profile: 'omar' })

    prepareDefaultNewSession()

    expect($newChatProfile.get()).toBe('omar')
    const params = await desktopSessionCreateParams('')
    expect(params.profile).toBe('omar')
  })
})
