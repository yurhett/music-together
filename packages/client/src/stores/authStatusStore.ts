import { create } from 'zustand'
import type { PlatformAuthStatus } from '@music-together/shared'

interface AuthStatusStore {
  platformStatus: PlatformAuthStatus[]
  statusLoaded: boolean
  setPlatformStatus: (status: PlatformAuthStatus[]) => void
  reset: () => void
}

export const useAuthStatusStore = create<AuthStatusStore>((set) => ({
  platformStatus: [],
  statusLoaded: false,
  setPlatformStatus: (platformStatus) => set({ platformStatus, statusLoaded: true }),
  reset: () => set({ platformStatus: [], statusLoaded: false }),
}))
