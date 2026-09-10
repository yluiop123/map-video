/**
 * procedural-models.ts — 内置 3D 简模（three.js 基础几何拼装，零二进制资源）
 *
 * 为什么要程序化：内置模型若要打包真实 .glb，体积与维护成本都高；
 * 用基础几何拼出「能认出来」的简模即可满足地图标记场景。
 * 想换成真实模型时：把 .glb 放进 `src/assets/builtin/`，在 model-renderer 里改加载源即可。
 *
 * 约定：模型以原点为中心、尺寸归一在 2 个单位内（渲染端按 sizeMeters 换算真实尺度）。
 */
import * as THREE from 'three';
import type { ProceduralModel } from './builtin-assets';

/**
 * 材质按元素颜色生成（白色/浅色基图 + Lambert 灯光 → 主/暗/强调三档明度差）。
 * 默认色保持原浅暖灰 0xd7d3ce，避免纯白过曝。
 */
const DEFAULT_COLOR = '#d7d3ce';

function makeMaterials(color: string) {
  const base = (() => {
    try { return new THREE.Color(color); } catch { return new THREE.Color(DEFAULT_COLOR); }
  })();
  const main = new THREE.MeshLambertMaterial({ color: base });
  const dark = new THREE.MeshLambertMaterial({ color: base.clone().multiplyScalar(0.55) });
  const accent = new THREE.MeshLambertMaterial({ color: base.clone().lerp(new THREE.Color('#6b7280'), 0.55) });
  return { main, dark, accent };
}

type Mats = ReturnType<typeof makeMaterials>;

/** 把一个几何体放到指定位置/旋转，加入组 */
function part(
  group: THREE.Group,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  pos: [number, number, number] = [0, 0, 0],
  rot: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(...pos);
  mesh.rotation.set(...rot);
  group.add(mesh);
  return mesh;
}

/** 无人机：机身 + 4 旋翼臂 + 4 旋翼 */
function buildDrone(m: Mats): THREE.Group {
  const g = new THREE.Group();
  part(g, new THREE.BoxGeometry(0.5, 0.16, 0.9), m.main);                     // 机身
  part(g, new THREE.SphereGeometry(0.18, 12, 10), m.accent, [0, -0.12, 0.25]); // 云台
  const arm = new THREE.CylinderGeometry(0.045, 0.045, 0.95, 8);
  const rotor = new THREE.CylinderGeometry(0.34, 0.34, 0.035, 16);
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    part(g, arm, m.dark, [sx * 0.42, 0.02, sz * 0.42], [0, 0, Math.PI / 2]);   // 旋翼臂
    part(g, rotor, m.accent, [sx * 0.72, 0.1, sz * 0.72]);                     // 旋翼
  }
  return g;
}

/** 战机：机身 + 三角翼 + 尾翼 */
function buildJet(m: Mats): THREE.Group {
  const g = new THREE.Group();
  part(g, new THREE.CylinderGeometry(0.16, 0.16, 1.6, 12), m.main, [0, 0, 0], [Math.PI / 2, 0, 0]);
  part(g, new THREE.ConeGeometry(0.16, 0.42, 12), m.main, [0, 0, 1.0], [Math.PI / 2, 0, 0]); // 机头
  const wing = new THREE.BoxGeometry(1.7, 0.045, 0.5);
  part(g, wing, m.dark, [0, 0, -0.05]);
  part(g, new THREE.BoxGeometry(0.72, 0.04, 0.3), m.dark, [0, 0.06, -0.72]);   // 尾翼
  part(g, new THREE.BoxGeometry(0.04, 0.36, 0.3), m.dark, [0, 0.2, -0.76]);    // 垂直尾
  return g;
}

/** 坦克：车体 + 炮塔 + 炮管 + 履带 */
function buildTank(m: Mats): THREE.Group {
  const g = new THREE.Group();
  part(g, new THREE.BoxGeometry(0.9, 0.26, 1.4), m.main);                       // 车体
  for (const sx of [-1, 1]) {
    part(g, new THREE.BoxGeometry(0.2, 0.22, 1.5), m.dark, [sx * 0.52, -0.04, 0]); // 履带
  }
  part(g, new THREE.CylinderGeometry(0.32, 0.36, 0.24, 14), m.accent, [0, 0.24, -0.06]); // 炮塔
  part(g, new THREE.CylinderGeometry(0.05, 0.05, 0.95, 10), m.dark, [0, 0.28, 0.45], [Math.PI / 2, 0, 0]); // 炮管
  return g;
}

/** 军舰：船体 + 上层建筑 + 桅杆 */
function buildShip(m: Mats): THREE.Group {
  const g = new THREE.Group();
  part(g, new THREE.BoxGeometry(0.6, 0.22, 1.9), m.main);                        // 船体
  part(g, new THREE.ConeGeometry(0.3, 0.5, 4), m.main, [0, 0, 1.15], [Math.PI / 2, 0, Math.PI / 4]); // 舰艏
  part(g, new THREE.BoxGeometry(0.42, 0.3, 0.7), m.accent, [0, 0.24, -0.1]); // 上层建筑
  part(g, new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6), m.dark, [0, 0.6, -0.25]); // 桅杆
  return g;
}

/** 导弹：弹体 + 锥头 + 尾翼 */
function buildMissile(m: Mats): THREE.Group {
  const g = new THREE.Group();
  part(g, new THREE.CylinderGeometry(0.14, 0.14, 0.95, 12), m.main, [0, 0, 0], [Math.PI / 2, 0, 0]);
  part(g, new THREE.ConeGeometry(0.14, 0.4, 12), m.accent, [0, 0, 0.66], [Math.PI / 2, 0, 0]);
  for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    part(g, new THREE.BoxGeometry(0.28, 0.03, 0.3), m.dark, [Math.cos(a) * 0.16, Math.sin(a) * 0.16, -0.42]);
  }
  return g;
}

const BUILDERS: Record<ProceduralModel['kind'], (m: Mats) => THREE.Group> = {
  drone: buildDrone,
  jet: buildJet,
  tank: buildTank,
  ship: buildShip,
  missile: buildMissile,
};

const cache = new Map<string, THREE.Group>();

/** 取（并缓存）程序化简模；按 kind + 颜色 缓存。返回的 Group 由渲染端负责挂载/卸载，勿直接修改其 scale */
export function getProceduralModel(kind: ProceduralModel['kind'], color = DEFAULT_COLOR): THREE.Group {
  const key = `${kind}:${color}`;
  let g = cache.get(key);
  if (!g) {
    g = BUILDERS[kind](makeMaterials(color));
    cache.set(key, g);
  }
  return g;
}
