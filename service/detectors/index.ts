/**
 * Ghép các detector thành một báo cáo tĩnh. Suy đoán quan hệ theo tên field (ví dụ customer_id → customers)
 * chỉ thêm khi chưa có quan hệ khai báo cho field đó, và luôn đánh dấu confidence "inferred".
 */
import type { SchemaCollection, SchemaReport, SchemaRelation } from '../../shared/api.ts';
import { LIMITS, mergeCollections, mergeRelations } from '../schema-report.ts';
import type { ScanFile } from '../schema-scan.ts';
import { type Detector } from './common.ts';
import { jsonschemaDetector } from './jsonschema.ts';
import { laravelDetector } from './laravel.ts';
import { mongooseDetector } from './mongoose.ts';
import { prismaDetector } from './prisma.ts';
import { typeormDetector } from './typeorm.ts';

export const DETECTORS: Detector[] = [laravelDetector, mongooseDetector, typeormDetector, prismaDetector, jsonschemaDetector];

const STEM = /^(.+?)(?:_id|Id)$/;

/** Quan hệ suy đoán: field "<x>_id" hoặc "<x>Id" trỏ tới collection tên x, xs hoặc xes (không phân biệt hoa thường). */
export function inferRelations(collections: SchemaCollection[], declared: SchemaRelation[]): SchemaRelation[] {
  const byName = new Map(collections.map((c) => [c.name.toLowerCase(), c.name]));
  const byModel = new Map(collections.flatMap((c) => (c.model ? [[c.model.toLowerCase(), c.name] as const] : [])));
  const declaredKeys = new Set(declared.map((r) => `${r.from}|${r.field ?? ''}`));
  const inferred: SchemaRelation[] = [];
  for (const collection of collections) {
    for (const field of collection.fields) {
      const match = STEM.exec(field.name);
      if (!match) continue;
      const stem = (match[1] ?? '').toLowerCase();
      const target = byName.get(stem) ?? byName.get(`${stem}s`) ?? byName.get(`${stem}es`) ?? byModel.get(stem);
      if (!target || target === collection.name || declaredKeys.has(`${collection.name}|${field.name}`)) continue;
      inferred.push({ from: collection.name, to: target, field: field.name, kind: 'reference', confidence: 'inferred' });
    }
  }
  return inferred;
}

/**
 * Quét và phân tích danh sách file thành báo cáo tĩnh (chưa qua validateReport).
 *
 * Args:
 *   files: File mã nguồn đã đọc.
 *   options: truncated và cảnh báo từ bước quét file.
 */
export function analyze(files: ScanFile[], options: { truncated?: boolean; warnings?: string[] } = {}): SchemaReport {
  const results = DETECTORS.map((detector) => ({ id: detector.id, draft: detector.detect(files) }));
  const used = results.filter((r) => r.draft.collections.length + r.draft.relations.length > 0).map((r) => r.id);
  const collections = mergeCollections(results.flatMap((r) => r.draft.collections));
  const declared = mergeRelations(results.flatMap((r) => r.draft.relations));
  const inferred = inferRelations(collections, declared);
  const warnings = [...(options.warnings ?? []), ...results.flatMap((r) => r.draft.warnings)];
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: { kind: 'static', detectors: used },
    truncated: (options.truncated ?? false) || collections.length >= LIMITS.collections,
    warnings: warnings.slice(0, LIMITS.warnings),
    collections,
    relations: mergeRelations([...declared, ...inferred]),
  };
}
