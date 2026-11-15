import { describe, expect, test } from 'bun:test';

import { combineReports, scrubString, validateReport } from './schema-report.ts';
import type { SchemaReport } from '../shared/api.ts';

const base = (over: Partial<SchemaReport> = {}): SchemaReport => ({
  version: 1,
  generatedAt: '2026-11-15T00:00:00.000Z',
  source: { kind: 'static', detectors: ['laravel-mongodb'] },
  truncated: false,
  warnings: [],
  collections: [],
  relations: [],
  ...over,
});

describe('scrubString', () => {
  test('xoá URI mongodb (kể cả có user:password) và chuỗi token dài', () => {
    const out = scrubString('db mongodb://app:S3cret@h:27017/x and mongodb+srv://u:p@c.net/y ' + 'A'.repeat(50), 200);
    expect(out).not.toContain('S3cret');
    expect(out).not.toContain('u:p@');
    expect(out).toContain('[uri]');
    expect(out).toContain('[token]');
  });

  test('cắt theo độ dài tối đa và bỏ ký tự điều khiển', () => {
    expect(scrubString('abc\u0000def', 4)).toBe('abcd');
  });
});

describe('validateReport', () => {
  test('khoá lạ bị loại ở mọi tầng', () => {
    const { report } = validateReport({
      version: 1,
      generatedAt: 'x',
      evil: 'payload',
      collections: [{ name: 'customers', fields: [{ name: '_id', type: 'ObjectId', pk: true, extra: 1 }], indexes: [], extraKey: 2 }],
      relations: [],
    });
    expect(report).not.toBeNull();
    const text = JSON.stringify(report);
    expect(text).not.toContain('evil');
    expect(text).not.toContain('extraKey');
    expect(text).not.toContain('extra"');
  });

  test('version khác 1 hoặc không phải đối tượng → null', () => {
    expect(validateReport({ version: 2, collections: [] }).report).toBeNull();
    expect(validateReport('nope').report).toBeNull();
    expect(validateReport(null).report).toBeNull();
  });

  test('vượt 300 collection thì cắt và đánh dấu truncated', () => {
    const collections = Array.from({ length: 305 }, (_, i) => ({ name: `c${i}`, fields: [], indexes: [] }));
    const { report, warnings } = validateReport({ version: 1, collections, relations: [] });
    expect(report?.collections).toHaveLength(300);
    expect(report?.truncated).toBe(true);
    expect(warnings.some((w) => w.includes('300'))).toBe(true);
  });

  test('quá 512 KB → null với cảnh báo', () => {
    const fields = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}_${'x'.repeat(120)}`, type: 'string' }));
    const collections = Array.from({ length: 300 }, (_, i) => ({ name: `c${i}`, fields, indexes: [] }));
    const result = validateReport({ version: 1, collections, relations: [] });
    expect(result.report).toBeNull();
    expect(result.warnings.join(' ')).toContain('too large');
  });

  test('tên có URI bị xoá, tên và type bị cắt độ dài', () => {
    const { report } = validateReport({
      version: 1,
      collections: [{ name: 'mongodb://a:pw@h/db', fields: [{ name: 'n'.repeat(300), type: 't'.repeat(100) }], indexes: [] }],
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain('pw@');
    expect(report?.collections[0]?.fields[0]?.name.length).toBeLessThanOrEqual(128);
    expect(report?.collections[0]?.fields[0]?.type.length).toBeLessThanOrEqual(64);
  });

  test('đường dẫn file phải tương đối: ".." và tuyệt đối bị loại', () => {
    const relPath = validateReport({ version: 1, collections: [{ name: 'a', file: 'app/Models/A.php', fields: [], indexes: [] }] }).report;
    expect(relPath?.collections[0]?.file).toBe('app/Models/A.php');
    const up = validateReport({ version: 1, collections: [{ name: 'a', file: '../../etc/passwd', fields: [], indexes: [] }] });
    expect(up.report?.collections[0]?.file).toBeNull();
    const abs = validateReport({ version: 1, collections: [{ name: 'a', file: '/etc/passwd', fields: [], indexes: [] }] });
    expect(abs.report?.collections[0]?.file).toBeNull();
  });
});

describe('combineReports', () => {
  test('khai báo thắng suy đoán; trường được gộp theo tên; quan hệ không trùng', () => {
    const declared = base({
      collections: [{
        name: 'customers', model: 'Customer', file: 'app/Models/Customer.php', orm: 'laravel-mongodb', confidence: 'declared', origin: 'static',
        fields: [{ name: 'cif', type: 'mixed', required: false, pk: false, array: false, inferred: false, children: [] }], indexes: [],
      }],
    });
    const agent = base({
      source: { kind: 'agent', detectors: [] },
      collections: [{
        name: 'customers', model: null, file: null, orm: 'agent', confidence: 'inferred', origin: 'agent',
        fields: [
          { name: 'cif', type: 'string', required: true, pk: false, array: false, inferred: true, children: [] },
          { name: 'phone', type: 'string', required: false, pk: false, array: false, inferred: true, children: [] },
        ], indexes: [],
      }],
      relations: [{ from: 'customers', to: 'orders', field: null, kind: 'hasMany', confidence: 'inferred' }],
    });
    const merged = combineReports(declared, agent);
    const c = merged.collections.find((x) => x.name === 'customers');
    expect(c?.file).toBe('app/Models/Customer.php');
    expect(c?.confidence).toBe('declared');
    expect(c?.fields.map((f) => f.name).sort()).toEqual(['cif', 'phone']);
    expect(c?.fields.find((f) => f.name === 'cif')?.inferred).toBe(false);
    expect(merged.relations).toHaveLength(1);
    expect(merged.source.kind).toBe('merged');
  });
});
