import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateLayout, MAX_LAYOUT_BYTES, MAX_LAYOUT_ENTRIES } from './layout.ts';
import { layoutGetRoute, layoutSaveRoute } from './handlers/layout.ts';
import { HttpError } from './errors.ts';

let sandbox = '';
beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'ms-layout-'));
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function project(name: string): string {
  const dir = path.join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('validateLayout', () => {
  test('nhận vị trí hữu hạn; bỏ trường lạ trong từng mục', () => {
    const result = validateLayout({ positions: { customers: { x: 10, y: -20, evil: 1 } } });
    expect(result).toEqual({ positions: { customers: { x: 10, y: -20 } } });
  });

  test('số không hữu hạn (NaN, Infinity, chuỗi) bị từ chối', () => {
    expect('error' in validateLayout({ positions: { a: { x: NaN, y: 0 } } })).toBe(true);
    expect('error' in validateLayout({ positions: { a: { x: 0, y: Infinity } } })).toBe(true);
    expect('error' in validateLayout({ positions: { a: { x: '5', y: 0 } } })).toBe(true);
  });

  test('quá 500 mục bị từ chối', () => {
    const positions: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i <= MAX_LAYOUT_ENTRIES; i += 1) positions[`c${i}`] = { x: i, y: i };
    expect('error' in validateLayout({ positions })).toBe(true);
  });

  test('tên có ký tự điều khiển, rỗng, quá 128 ký tự, hoặc __proto__ bị từ chối', () => {
    expect('error' in validateLayout({ positions: { 'a\u0007b': { x: 0, y: 0 } } })).toBe(true);
    expect('error' in validateLayout({ positions: { '': { x: 0, y: 0 } } })).toBe(true);
    expect('error' in validateLayout({ positions: { ['n'.repeat(129)]: { x: 0, y: 0 } } })).toBe(true);
    expect('error' in validateLayout(JSON.parse('{"positions":{"__proto__":{"x":0,"y":0}}}'))).toBe(true);
  });

  test('quá 256 KB (đầu vào phình to) bị từ chối trước khi làm sạch', () => {
    const input = { positions: { a: { x: 0, y: 0 } }, junk: 'x'.repeat(MAX_LAYOUT_BYTES + 10) };
    expect('error' in validateLayout(input)).toBe(true);
  });

  test('input không phải đối tượng hoặc thiếu positions bị từ chối', () => {
    expect('error' in validateLayout(null)).toBe(true);
    expect('error' in validateLayout({})).toBe(true);
    expect('error' in validateLayout({ positions: [] })).toBe(true);
  });
});

describe('route layout (get/save)', () => {
  test('không có file → positions rỗng', async () => {
    const dir = project('empty');
    expect(await layoutGetRoute({ directory: dir })).toEqual({ positions: {} });
  });

  test('save rồi get khớp; file 0644 và thư mục 0700 (dự án mới)', async () => {
    const dir = project('roundtrip');
    const saved = await layoutSaveRoute({ directory: dir, positions: { customers: { x: 40, y: 12 }, orders: { x: 300, y: 0 } } });
    expect(saved.written).toBe('.openchamber/mongo-studio/layout.json');
    expect(await layoutGetRoute({ directory: dir })).toEqual({ positions: { customers: { x: 40, y: 12 }, orders: { x: 300, y: 0 } } });
    const file = path.join(dir, '.openchamber/mongo-studio/layout.json');
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(statSync(path.join(dir, '.openchamber/mongo-studio')).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, '.openchamber')).mode & 0o777).toBe(0o700);
  });

  test('ghi nguyên tử: không còn file tạm .tmp sau khi lưu', async () => {
    const dir = project('atomic');
    await layoutSaveRoute({ directory: dir, positions: { a: { x: 1, y: 2 } } });
    expect(readdirSync(path.join(dir, '.openchamber/mongo-studio')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('positions rỗng là hợp lệ: "Sắp xếp lại" ghi {} và giữ file', async () => {
    const dir = project('reset');
    await layoutSaveRoute({ directory: dir, positions: { a: { x: 1, y: 2 } } });
    await layoutSaveRoute({ directory: dir, positions: {} });
    expect(await layoutGetRoute({ directory: dir })).toEqual({ positions: {} });
    expect(readFileSync(path.join(dir, '.openchamber/mongo-studio/layout.json'), 'utf8')).toContain('"positions"');
  });

  test('save với dữ liệu sai → HttpError 400 BAD_LAYOUT', async () => {
    const dir = project('bad');
    const error = await layoutSaveRoute({ directory: dir, positions: { a: { x: NaN, y: 0 } } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe('BAD_LAYOUT');
    expect((error as HttpError).status).toBe(400);
  });

  test('.openchamber là symlink → 400 UNSAFE_PATH cho cả get và save', async () => {
    const dir = project('symlink');
    const elsewhere = path.join(sandbox, 'elsewhere-layout');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, path.join(dir, '.openchamber'));
    const save = await layoutSaveRoute({ directory: dir, positions: {} }).catch((e: unknown) => e);
    expect((save as HttpError).code).toBe('UNSAFE_PATH');
    const get = await layoutGetRoute({ directory: dir }).catch((e: unknown) => e);
    expect((get as HttpError).code).toBe('UNSAFE_PATH');
    expect((get as HttpError).message).toContain('không ghi được báo cáo');
  });

  test('layout.json là symlink → 400 UNSAFE_PATH khi đọc', async () => {
    const dir = project('link-file');
    mkdirSync(path.join(dir, '.openchamber/mongo-studio'), { recursive: true });
    writeFileSync(path.join(sandbox, 'outside-layout.json'), '{"positions":{}}');
    symlinkSync(path.join(sandbox, 'outside-layout.json'), path.join(dir, '.openchamber/mongo-studio/layout.json'));
    const error = await layoutGetRoute({ directory: dir }).catch((e: unknown) => e);
    expect((error as HttpError).code).toBe('UNSAFE_PATH');
  });

  test('đường dẫn có ".." → 400 BAD_DIRECTORY', async () => {
    const dir = project('traversal');
    const error = await layoutSaveRoute({ directory: `${dir}/..`, positions: {} }).catch((e: unknown) => e);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).code).toBe('BAD_DIRECTORY');
  });
});
