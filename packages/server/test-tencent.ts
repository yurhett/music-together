const types = [2,3,4,8,9,10]
for (const t of types) {
  const payload = {
    comm: { ct: '6', cv: '80600', tmeAppID: 'qqmusic' },
    'music.search.SearchCgiService.DoSearchForQQMusicDesktop': {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { num_per_page: 1, page_num: 1, search_type: t, query: '周杰伦', grp: 1 },
    },
  }
  const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', { method: 'POST', body: JSON.stringify(payload) }).then(r => r.json())
  const data = r['music.search.SearchCgiService.DoSearchForQQMusicDesktop'].data
  const keys = Object.keys(data.body).filter(k => data.body[k]?.list?.length > 0)
  console.log(`Type ${t}: ${keys.join(', ')}`)
}
