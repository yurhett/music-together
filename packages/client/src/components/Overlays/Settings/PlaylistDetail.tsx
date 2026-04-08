import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { VirtualTrackList } from '@/components/VirtualTrackList'
import { getVipTrackBlockedReason, isVipTrackBlocked } from '@/lib/platform'
import { trackKey } from '@/lib/utils'
import { useRoomStore } from '@/stores/roomStore'
import { useAuthStatusStore } from '@/stores/authStatusStore'
import type { Playlist, Track } from '@music-together/shared'
import { LIMITS } from '@music-together/shared'
import { ArrowLeft, ListPlus, Music } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'

const EMPTY_QUEUE: Track[] = []

interface PlaylistDetailProps {
  playlist: Playlist | null
  tracks: Track[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  total: number
  onBack: () => void
  onAddTrack: (track: Track) => void
  onAddAll: (tracks: Track[], playlistName?: string) => void
  onLoadMore: () => void
}

export function PlaylistDetail({
  playlist,
  tracks,
  loading,
  loadingMore,
  hasMore,
  total,
  onBack,
  onAddTrack,
  onAddAll,
  onLoadMore,
}: PlaylistDetailProps) {
  const queue = useRoomStore((s) => s.room?.queue ?? EMPTY_QUEUE)
  const platformStatus = useAuthStatusStore((s) => s.platformStatus)
  const statusLoaded = useAuthStatusStore((s) => s.statusLoaded)
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())
  const queueKeys = useMemo(() => new Set(queue.map(trackKey)), [queue])

  const isTrackAddDisabled = useCallback(
    (track: Track) => isVipTrackBlocked(track, platformStatus, statusLoaded),
    [platformStatus, statusLoaded],
  )

  const getTrackAddDisabledReason = useCallback(
    (track: Track) => getVipTrackBlockedReason(track, platformStatus, statusLoaded),
    [platformStatus, statusLoaded],
  )

  const isTrackAdded = useCallback(
    (track: Track) => {
      const key = trackKey(track)
      return addedIds.has(key) || queueKeys.has(key)
    },
    [addedIds, queueKeys],
  )

  const handleAddTrack = useCallback(
    (track: Track) => {
      const key = trackKey(track)
      if (queueKeys.has(key) || addedIds.has(key)) {
        toast.info(`「${track.title}」已在队列中`)
        return
      }

      const blockedReason = getTrackAddDisabledReason(track)
      if (blockedReason) {
        toast.error(`「${track.title}」是 VIP 歌曲，${blockedReason}`)
        return
      }

      onAddTrack(track)
      setAddedIds((prev) => new Set(prev).add(key))
      toast.success(`已添加「${track.title}」`)
    },
    [onAddTrack, queueKeys, addedIds, getTrackAddDisabledReason],
  )

  // Dynamic "add all" logic — filter duplicates
  const availableSlots = LIMITS.QUEUE_MAX_SIZE - queue.length
  const uniqueTracks = useMemo(() => tracks.filter((t) => !isTrackAdded(t)), [tracks, isTrackAdded])
  const blockedVipCount = useMemo(
    () => uniqueTracks.filter((track) => isTrackAddDisabled(track)).length,
    [uniqueTracks, isTrackAddDisabled],
  )
  const addableTracks = useMemo(
    () => uniqueTracks.filter((track) => !isTrackAddDisabled(track)),
    [uniqueTracks, isTrackAddDisabled],
  )
  const addCount = Math.min(availableSlots, addableTracks.length)
  const isQueueFull = availableSlots <= 0

  const handleAddAll = useCallback(() => {
    if (addCount <= 0) return
    const toAdd = addableTracks.slice(0, addCount)
    onAddAll(toAdd, playlist?.name)
    setAddedIds((prev) => {
      const next = new Set(prev)
      for (const t of toAdd) next.add(trackKey(t))
      return next
    })
    const skippedByQueueLimit = Math.max(0, addableTracks.length - addCount)
    if (blockedVipCount > 0 || skippedByQueueLimit > 0) {
      const summary: string[] = []
      if (blockedVipCount > 0) summary.push(`跳过 ${blockedVipCount} 首 VIP 歌曲`)
      if (skippedByQueueLimit > 0) summary.push(`队列已满未添加 ${skippedByQueueLimit} 首`)
      toast.success(`已添加 ${addCount} 首到队列（${summary.join('，')}）`)
    } else {
      toast.success(`已添加全部 ${addCount} 首到队列`)
    }
  }, [addCount, addableTracks, onAddAll, playlist?.name, blockedVipCount])

  // Button label
  let addAllLabel: string
  if (loading) {
    addAllLabel = '加载中…'
  } else if (tracks.length === 0) {
    addAllLabel = '添加全部'
  } else if (isQueueFull) {
    addAllLabel = '队列已满'
  } else if (addableTracks.length === 0 && blockedVipCount > 0) {
    addAllLabel = '需平台 VIP'
  } else if (uniqueTracks.length === 0) {
    addAllLabel = '全部已添加'
  } else if (addCount === addableTracks.length) {
    addAllLabel = `添加全部 ${addCount} 首`
  } else {
    addAllLabel = `添加 ${addCount} 首到队列`
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {/* Row 1: Back + Title — pr-8 reserves space for dialog close button */}
      <div className="flex shrink-0 items-center gap-2 pr-8">
        <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 shrink-0">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h4 className="min-w-0 flex-1 truncate text-sm font-semibold">{playlist?.name ?? '歌单详情'}</h4>
      </div>

      {/* Row 2: Info + Action */}
      <div className="flex shrink-0 items-center justify-between gap-3 py-1">
        <p className="text-muted-foreground text-xs">
          {loading
            ? '加载中…'
            : `${total} 首${tracks.length < total ? `（已加载 ${tracks.length}）` : ''}${playlist?.creator ? ` · ${playlist.creator}` : ''}`}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={handleAddAll}
          disabled={loading || isQueueFull || addableTracks.length === 0}
          className="shrink-0 gap-1"
        >
          <ListPlus className="h-3.5 w-3.5" />
          {addAllLabel}
        </Button>
      </div>

      {statusLoaded && blockedVipCount > 0 && (
        <p className="pb-1 text-[11px] text-amber-600">当前房间暂无对应平台 VIP，{blockedVipCount} 首 VIP 歌曲不可添加</p>
      )}

      <Separator className="shrink-0" />

      {/* Track list with shared virtual scrolling component */}
      <VirtualTrackList
        tracks={tracks}
        loading={loading}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
        isTrackAdded={isTrackAdded}
        isTrackAddDisabled={isTrackAddDisabled}
        getTrackAddDisabledReason={getTrackAddDisabledReason}
        onAddTrack={handleAddTrack}
        emptyIcon={<Music className="h-8 w-8" />}
        emptyMessage="歌单为空"
        className="border-0 rounded-none"
      />
    </div>
  )
}
