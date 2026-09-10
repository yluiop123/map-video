/** gifuct-js 未提供类型声明，这里给出最小可用声明 */
declare module 'gifuct-js' {
  export interface GifFrameDims {
    top: number;
    left: number;
    width: number;
    height: number;
  }
  export interface GifFrame {
    dims: GifFrameDims;
    /** RGBA 像素（decompressFrames 第二参数为 true 时提供） */
    patch: Uint8ClampedArray;
    /** 显示时长，单位 1/100 秒 */
    delay: number;
    /** 处置方式：0/1 保留、2 恢复背景、3 恢复上一帧 */
    disposalType?: number;
  }
  export function parseGIF(data: ArrayBuffer): { lsd?: { width: number; height: number } };
  export function decompressFrames(gif: unknown, buildImagePatches: boolean): GifFrame[];
}
