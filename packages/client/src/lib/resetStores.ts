import { useRoomStore } from '@/stores/roomStore'
import { usePlayerStore } from '@/stores/playerStore'
import { useChatStore } from '@/stores/chatStore'
import { useAuthStatusStore } from '@/stores/authStatusStore'
import { resetClockSync } from '@/lib/clockSync'

/** Reset all room-related stores at once (used on explicit leave or terminal room errors) */
export function resetAllRoomState() {
  useRoomStore.getState().reset()
  usePlayerStore.getState().reset()
  useChatStore.getState().reset()
  useAuthStatusStore.getState().reset()
  resetClockSync()
}
