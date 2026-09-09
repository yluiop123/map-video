// 校验 dist base 路径（web=/map-video/，desktop=./）
const fs = require('fs');
const s = fs.readFileSync('dist/index.html', 'utf8');
const m = s.match(/src="([^"]+)"/);
console.log('base:', m ? m[1] : 'not found');
