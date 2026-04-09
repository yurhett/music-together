# Add Playlist Search Support Spec

## Why
用户希望能够搜索 QQ 音乐和网易云音乐的歌单，以便快速找到并播放别人创建的歌单合集。

## What Changes
- 后端增加对歌单搜索（Playlist Search）的支持，兼容 Tencent (QQ 音乐) 和 Netease (网易云音乐) 以及 Kugou (酷狗音乐) 平台。
- 扩展共享类型和接口约束，在 `searchQuerySchema` 中支持 `type: 'playlist'`。
- 前端 UI 的搜索面板新增“歌单”选项卡。
- 前端搜索 Hook (`useSearch`) 支持传入 `playlist` 类型，并能够复用现有的歌单展示组件。

## Impact
- Affected specs: 搜索功能、歌单解析功能
- Affected code:
  - `packages/shared/src/schemas.ts`
  - `packages/client/src/hooks/useSearch.ts`
  - `packages/client/src/components/Overlays/SearchDialog.tsx`
  - `packages/server/src/routes/music.ts`
  - `packages/server/src/services/musicProvider.ts`

## ADDED Requirements
### Requirement: Playlist Search
The system SHALL provide the ability to search for playlists by keyword across supported music platforms.

#### Scenario: Success case
- **WHEN** user opens search dialog and selects "歌单" tab, then inputs a keyword
- **THEN** system fetches playlist results from the selected music platform and displays them, allowing user to click and view the playlist tracks.
