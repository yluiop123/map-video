/**
 * model-renderer.ts — 3D 模型 → 位图（离屏渲染，确定性优先）
 *
 * ★ 为什么不用「共享 MapLibre WebGL 上下文的 custom layer」：
 *   Remotion 要求每帧是 frame 的纯函数（可乱序、可重复渲染），而共享上下文会带来
 *   抓帧时序、GL 状态污染、并发竞争三类风险。这里改为：
 *   three 用**独立 canvas + 独立 GL 上下文**离屏渲染 → 输出 ImageData → 交给 MapLibre
 *   的图片管线（与 image/gif 形态同一条路）。抓帧时 MapLibre canvas 里只有普通位图。
 *
 * 确定性守则（务必遵守）：
 *   · 不用 requestAnimationFrame，渲染完全由调用方按 frame 显式触发
 *   · 不用 clock/delta，姿态由参数（角度）决定
 *   · 角度量化为 10° 一档并缓存，避免每帧重复渲染
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getProceduralModel } from './procedural-models';
import type { ProceduralModel } from './builtin-assets';

/** 位图分辨率（会按 scale 在 MapLibre 侧缩放） */
const SIZE = 96;

interface Env {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  out: HTMLCanvasElement;
  outCtx: CanvasRenderingContext2D;
}

let env: Env | null = null;

function ensureEnv(): Env | null {
  if (env) return env;
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,   // 离屏抓图必须
  });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  // 固定等距视角：与地图 pitch/bearing 解耦，保证同一输入永远同一张图
  camera.position.set(2.6, 2.2, 3.0);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  const out = document.createElement('canvas');
  out.width = SIZE;
  out.height = SIZE;
  const outCtx = out.getContext('2d', { willReadFrequently: true })!;

  env = { renderer, scene, camera, out, outCtx };
  return env;
}

function grab(e: Env): ImageData {
  e.outCtx.clearRect(0, 0, SIZE, SIZE);
  e.outCtx.drawImage(e.renderer.domElement, 0, 0, SIZE, SIZE);
  return e.outCtx.getImageData(0, 0, SIZE, SIZE);
}

const bucketOf = (deg: number) => Math.round(deg / 10) * 10;

const procCache = new Map<string, ImageData>();
const GLTF_CACHE = new Map<string, THREE.Group>();
const gltfBitmapCache = new Map<string, ImageData>();

/** 程序化简模 → 位图（同步；角度量化 + 颜色 缓存） */
export function renderProceduralModel(kind: ProceduralModel['kind'], angleDeg = 0, color = '#d7d3ce'): ImageData | null {
  const bucket = bucketOf(angleDeg);
  const key = `proc:${kind}:${bucket}:${color}`;
  const hit = procCache.get(key);
  if (hit) return hit;

  const e = ensureEnv();
  if (!e) return null;

  const group = getProceduralModel(kind, color);
  group.rotation.set(0, THREE.MathUtils.degToRad(bucket), 0);
  e.scene.add(group);
  e.renderer.render(e.scene, e.camera);
  const data = grab(e);
  e.scene.remove(group);

  procCache.set(key, data);
  return data;
}

/**
 * 上传模型染色：clone 一份并把材质 color 乘上目标色（白色=原色不处理）。
 * 不改动 GLTF_CACHE 里的原始 Group（材质引用会被共享，必须 clone 材质）。
 */
function tintedClone(root: THREE.Group, color: string): THREE.Group {
  if (!color || color.toUpperCase() === '#FFFFFF') return root;
  const tint = new THREE.Color(color);
  const clone = root.clone(true);
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const apply = (m: THREE.Material): THREE.Material => {
      const cm = m.clone();
      const std = cm as THREE.MeshStandardMaterial;
      if (std.color) std.color.multiply(tint);
      return cm;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(apply) : apply(mesh.material);
  });
  return clone;
}

/** 加载并归一化用户上传的 glTF / GLB（归一为 2 单位包围盒，居中） */
export async function loadGltfModel(url: string): Promise<THREE.Group | null> {
  const hit = GLTF_CACHE.get(url);
  if (hit) return hit;
  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const s = 2 / maxDim;
    root.scale.setScalar(s);
    root.position.sub(box.getCenter(new THREE.Vector3()).multiplyScalar(s));
    GLTF_CACHE.set(url, root);
    return root;
  } catch {
    return null;
  }
}

/** 用户模型 → 位图（异步；按 url + 角度 + 颜色缓存） */
export async function renderGltfModel(url: string, angleDeg = 0, color = '#FFFFFF'): Promise<ImageData | null> {
  const bucket = bucketOf(angleDeg);
  const key = `gltf:${url}:${bucket}:${color}`;
  const hit = gltfBitmapCache.get(key);
  if (hit) return hit;

  const e = ensureEnv();
  if (!e) return null;
  const root = await loadGltfModel(url);
  if (!root) return null;

  const target = tintedClone(root, color);
  target.rotation.set(0, THREE.MathUtils.degToRad(bucket), 0);
  e.scene.add(target);
  e.renderer.render(e.scene, e.camera);
  const data = grab(e);
  e.scene.remove(target);

  gltfBitmapCache.set(key, data);
  return data;
}

/** 预加载（导出端在 Remotion delayRender 中调用，避免某帧模型尚未就绪而空白） */
export async function preloadModelAssets(urls: string[]): Promise<void> {
  await Promise.all(urls.map((u) => loadGltfModel(u)));
}

/** 释放模型缓存（切项目 / 停用时调用） */
export function clearModelCaches(): void {
  procCache.clear();
  gltfBitmapCache.clear();
  GLTF_CACHE.clear();
}
