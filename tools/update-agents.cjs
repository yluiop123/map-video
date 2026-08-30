// AGENTS.md 追加：镜头插值依赖教训 + i18n 约定
const fs = require('fs');
const p = 'AGENTS.md';
let s = fs.readFileSync(p, 'utf8');

const lesson11 = '11. **镜头插值 effect 的依赖必须是 `chapter.camera`（数组引用）而非 `chapter`**：任何元素属性修改都会重建 chapter 对象，若依赖 chapter 会在每次改样式/改属性时触发 `jumpTo`，把用户手动平移的地图拽回关键帧位置。';
if (!s.includes('11. **镜头插值')) {
  s = s.replace('10. **地图事件 vs 播放循环**：', lesson11 + '\n10. **地图事件 vs 播放循环**：');
}

const i18nLine = '- **属性面板双语**：editorStore.lang（中/EN，顶栏最右切换），标签用 `useT()` 钩子：`t(\'中文\', \'English\')`；新增属性标签必须双语。hints 暂仅中文。';
if (!s.includes('属性面板双语')) {
  s = s.replace('- **保存脏标记**：', i18nLine + '\n- **保存脏标记**：');
}

fs.writeFileSync(p, s, 'utf8');
console.log('lesson11:', s.includes('11. **镜头插值'), '| i18n:', s.includes('属性面板双语'));
