import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanRoute } from './handlers/diagram.ts';
import { HttpError } from './errors.ts';

let sandbox = '';
beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'ms-diag-'));
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function project(name: string): string {
  const dir = path.join(sandbox, name);
  mkdirSync(path.join(dir, 'app', 'Models'), { recursive: true });
  return dir;
}

describe('scanRoute ghi báo cáo (nút "Ghi báo cáo dự án")', () => {
  test('write=true ghi schema-scan.json đúng đường dẫn, không cần cờ bật/tắt nào khác', async () => {
    const dir = project('write-ok');
    const reply = await scanRoute({ directory: dir, write: true });
    expect(reply.written).toBe('.openchamber/mongo-studio/schema-scan.json');
    expect(JSON.parse(readFileSync(path.join(dir, '.openchamber/mongo-studio/schema-scan.json'), 'utf8')).version).toBe(1);
  });

  test('write=false (Quét lại) không tạo thư mục .openchamber', async () => {
    const dir = project('no-write');
    const reply = await scanRoute({ directory: dir, write: false });
    expect(reply.written).toBeNull();
    expect(existsSync(path.join(dir, '.openchamber'))).toBe(false);
  });

  test('.openchamber là symlink → HttpError 400 UNSAFE_PATH với thông báo tiếng Việt rõ ràng', async () => {
    const dir = project('symlink');
    const elsewhere = path.join(sandbox, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, path.join(dir, '.openchamber'));
    const error = await scanRoute({ directory: dir, write: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).code).toBe('UNSAFE_PATH');
    expect((error as HttpError).message).toContain('Could not write the report');
  });
});
