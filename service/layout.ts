/**
 * Vị trí các thẻ sơ đồ kéo thả (layout.json trong .openchamber/mongo-studio của dự án).
 * Chỉ chứa toạ độ số hữu hạn theo tên collection; mọi thứ khác bị loại.
 */

export const LAYOUT_FILE = 'layout.json';
export const MAX_LAYOUT_ENTRIES = 500;
export const MAX_LAYOUT_BYTES = 256 * 1024;

export type LayoutPoint = { x: number; y: number };
export type LayoutPositions = Record<string, LayoutPoint>;

const CONTROL = /[\u0000-\u001f\u007f]/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Tên collection hợp lệ để làm khoá: chuỗi 1–128 ký tự, không ký tự điều khiển, không khoá đặc biệt. */
export function isLayoutKey(key: string): boolean {
  return key.length >= 1 && key.length <= 128 && !CONTROL.test(key) && !FORBIDDEN_KEYS.has(key);
}

/**
 * Kiểm tra và làm sạch danh sách vị trí từ body hoặc từ file.
 *
 * Args:
 *   input: Giá trị đã parse, phải có khoá positions là đối tượng.
 *
 * Returns:
 *   { positions } khi hợp lệ, hoặc { error } với thông báo tiếng Việt.
 */
export function validateLayout(input: unknown): { positions: LayoutPositions } | { error: string } {
  if (Buffer.byteLength(JSON.stringify(input ?? null)) > MAX_LAYOUT_BYTES) {
    return { error: 'Vị trí sơ đồ quá lớn (trên 256 KB), không lưu.' };
  }
  if (!isObj(input) || !isObj(input.positions)) {
    return { error: 'Vị trí sơ đồ phải là đối tượng có khoá "positions".' };
  }
  const entries = Object.entries(input.positions);
  if (entries.length > MAX_LAYOUT_ENTRIES) {
    return { error: `Quá ${MAX_LAYOUT_ENTRIES} vị trí; chỉ lưu tối đa ${MAX_LAYOUT_ENTRIES} bảng.` };
  }
  const positions: LayoutPositions = {};
  for (const [key, value] of entries) {
    if (!isLayoutKey(key)) return { error: 'Tên bảng trong vị trí không hợp lệ (rỗng, quá dài, có ký tự điều khiển hoặc khoá đặc biệt).' };
    if (!isObj(value) || typeof value.x !== 'number' || typeof value.y !== 'number' || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
      return { error: `Vị trí của "${key}" phải có x và y là số hữu hạn.` };
    }
    positions[key] = { x: value.x, y: value.y };
  }
  if (Buffer.byteLength(JSON.stringify({ version: 1, positions })) > MAX_LAYOUT_BYTES) {
    return { error: 'Vị trí sơ đồ quá lớn (trên 256 KB), không lưu.' };
  }
  return { positions };
}
