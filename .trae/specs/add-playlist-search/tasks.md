# Tasks
- [x] Task 1: 更新共享库类型定义
  - [x] SubTask 1.1: 在 `packages/shared/src/schemas.ts` 中，将 `searchQuerySchema` 的 `type` 字段枚举增加 `'playlist'`
- [x] Task 2: 后端实现歌单搜索服务
  - [x] SubTask 2.1: 在 `packages/server/src/services/musicProvider.ts` 中新增 `searchPlaylist` 方法，实现对 Tencent, Netease, Kugou 的歌单搜索，并返回规范的 `Playlist[]` 结构
  - [x] SubTask 2.2: 在 `packages/server/src/routes/music.ts` 中处理 `/api/music/search` 路由的 `type === 'playlist'` 情况，并调用 `searchPlaylist`
- [x] Task 3: 前端 UI 与交互支持
  - [x] SubTask 3.1: 更新 `packages/client/src/hooks/useSearch.ts` 中的泛型约束以支持 `'playlist'`
  - [x] SubTask 3.2: 在 `packages/client/src/components/Overlays/SearchDialog.tsx` 中新增“歌单”搜索选项卡，支持渲染搜索到的歌单列表
