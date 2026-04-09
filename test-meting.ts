import Meting from '@meting/core'
const meting = new Meting('netease')
meting.search('周杰伦', { type: 'album' }).then(res => console.log(res.substring(0, 300)))
