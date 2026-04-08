import { PureAbility, AbilityBuilder } from '@casl/ability'
import type { UserRole } from './types.js'

export type Actions =
  | 'play'
  | 'pause'
  | 'seek'
  | 'next'
  | 'prev'
  | 'set-mode'
  | 'set-room-mode'
  | 'dissolve-room'
  | 'add'
  | 'remove'
  | 'reorder'
  | 'manage'
  | 'vote'
  | 'set-role'

export type Subjects = 'Player' | 'Queue' | 'Room' | 'all'

export type AppAbility = PureAbility<[Actions, Subjects]>

/**
 * Define CASL abilities for a given user role.
 *
 * - Owner: manage all (播放控制 + 队列 + 房间设置 + 角色管理 + 投票否决)
 * - Admin: 全部播放控制 + 全部队列权限 + 房间模式/解散
 * - Member: 仅添加歌曲 + 发起投票
 */
export function defineAbilityFor(role: UserRole): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(PureAbility)

  switch (role) {
    case 'owner':
      can('manage', 'all')
      break
    case 'admin':
      can('play', 'Player')
      can('pause', 'Player')
      can('seek', 'Player')
      can('next', 'Player')
      can('prev', 'Player')
      can('set-mode', 'Player')
      can('add', 'Queue')
      can('remove', 'Queue')
      can('reorder', 'Queue')
      can('set-room-mode', 'Room')
      can('dissolve-room', 'Room')
      break
    case 'member':
      can('add', 'Queue')
      can('vote', 'Player')
      break
  }

  return build()
}
