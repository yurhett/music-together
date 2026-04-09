import ncmApi from '@neteasecloudmusicapienhanced/api'
ncmApi.cloudsearch({ keywords: '周杰伦', limit: 2, type: 10 }).then(res => console.log(JSON.stringify(res.body.result, null, 2)))
