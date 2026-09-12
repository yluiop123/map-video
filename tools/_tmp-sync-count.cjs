// 临时：同步三表合并后的规模数字（22→20 表、330→316 列）
const fs = require('fs');
const files = ['AGENTS.md', 'docs/db-redesign.md', 'docs/db-tables.md'];
for (const f of files) {
  const before = fs.readFileSync(f, 'utf8');
  const after = before
    .split('22 张表').join('20 张表')
    .split('22 表创建成功').join('20 表创建成功')
    .split('330 列').join('316 列');
  if (before !== after) fs.writeFileSync(f, after, 'utf8');
  console.log(f, before === after ? '(无变化)' : '已更新');
}
