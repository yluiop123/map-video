/**
 * HotFixField — 项目级「发音修正」：两列行编辑器（词 → 读音 / 原文 → 替换）。
 *
 * 存的就是上游 `hot_fix` 那一份形状（一条 = 单键对象 `{词: 读音}`），所以调用时零转换；
 * 要数组形状的供应商由**模板**给这个参数选 `transform: hotFixArray`（引擎摊平），
 * 界面不认厂商名。哪条端点吃这个参数写在模板里，不在这里判断。
 */
import { useT } from './ui/primitives';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { HotFix } from '../types';

type Kind = keyof HotFix;

const rowsOf = (list: Record<string, string>[]) => list.map((o) => {
  const [k = '', v = ''] = Object.entries(o)[0] ?? [];
  return [k, v] as [string, string];
});
const pairs = (rows: [string, string][]) => rows.map(([k, v]) => ({ [k]: v }));

export function HotFixField({ value, onChange }: { value: HotFix; onChange: (next: HotFix) => void }) {
  const t = useT();
  const groups: { kind: Kind; title: string; keyPh: string; valPh: string }[] = [
    { kind: 'pronunciation', title: t('读音', 'Pronounce'), keyPh: t('词（如：重庆）', 'word'), valPh: t('读音（如：chong2 qing4）', 'pinyin') },
    { kind: 'replace', title: t('替换', 'Replace'), keyPh: t('原文（如：AI）', 'source'), valPh: t('换成（如：人工智能）', 'target') },
  ];
  /**
   * 编辑中的半截行**照原样存**（只填了「词」也留着）—— 一存就过滤会让那一行在敲第二个框的瞬间凭空消失。
   * 没填完的行由 `hotFixPayload` 在**要发给上游的那一刻**滤掉，界面上不做第二套过滤。
   */
  const edit = (kind: Kind, i: number, col: 0 | 1, text: string) => {
    const rows = rowsOf(value[kind]);
    rows[i] = col === 0 ? [text, rows[i]?.[1] ?? ''] : [rows[i]?.[0] ?? '', text];
    onChange({ ...value, [kind]: pairs(rows) });
  };

  return (
    <div className="space-y-1.5">
      {groups.map((g) => {
        const rows = rowsOf(value[g.kind]);
        return (
          <div key={g.kind} className="space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="w-9 shrink-0 text-[11px] text-muted-foreground">{g.title}</span>
              {rows.length === 0 && (
                <span className="text-[11px] text-muted-foreground/60">{t('未填（读错的专有名词才需要）', 'empty — only for words the voice misreads')}</span>
              )}
              <Button variant="outline" size="sm" className="h-6 px-2 text-[11px] ml-auto"
                onClick={() => onChange({ ...value, [g.kind]: [...pairs(rows), { '': '' }] })}
                title={t('加一条', 'Add one')}
              >＋</Button>
            </div>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5 pl-[45px]">
                <Input value={r[0]} onChange={(e) => edit(g.kind, i, 0, e.target.value)} placeholder={g.keyPh}
                  className="h-7 flex-1 min-w-0 text-xs" />
                <Input value={r[1]} onChange={(e) => edit(g.kind, i, 1, e.target.value)} placeholder={g.valPh}
                  className="h-7 flex-1 min-w-0 text-xs font-mono" />
                <button
                  onClick={() => onChange({ ...value, [g.kind]: pairs(rows.filter((_, j) => j !== i)) })}
                  className="h-7 w-6 shrink-0 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-white/10"
                  title={t('删掉这条', 'Delete')}
                >✕</button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
