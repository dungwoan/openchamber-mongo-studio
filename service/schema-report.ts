/**
 * Báo cáo sơ đồ v1: làm sạch mọi dữ liệu đi vào (từ quét tĩnh hoặc từ agent) và gộp hai báo cáo.
 * Quy tắc: chỉ giữ khoá đã biết; chuỗi bị xoá URI và token dài; đường dẫn file phải tương đối;
 * mọi danh sách bị cắt theo LIMITS; tổng kích thước tối đa 512 KB.
 */
import type { SchemaCollection, SchemaField, SchemaIndex, SchemaRelation, SchemaReport } from '../shared/api.ts';

export const LIMITS = {
  collections: 300,
  fieldsPerCollection: 100,
  fieldDepth: 3,
  childrenPerField: 50,
  indexesPerCollection: 50,
  relations: 1000,
  warnings: 50,
  bytes: 512 * 1024,
  name: 128,
  type: 64,
  path: 300,
  keysPerIndex: 16,
} as const;

const URI = /mongodb(?:\+srv)?:\/\/[^\s"'<>]*/gi;
const TOKEN = /[A-Za-z0-9+/_=-]{40,}/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const RELATION_KINDS = new Set(['belongsTo', 'hasMany', 'hasOne', 'belongsToMany', 'reference']);

type Obj = Record<string, unknown>;

/**
 * Xoá URI mongodb, chuỗi token dài và ký tự điều khiển; cắt theo độ dài tối đa.
 *
 * Args:
 *   value: Chuỗi cần làm sạch.
 *   max: Độ dài tối đa.
 */
export function scrubString(value: string, max: number): string {
  const cleaned = value.replace(CONTROL, '').replace(URI, '[uri]').replace(TOKEN, '[token]');
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStr = (value: unknown): value is string => typeof value === 'string';

function strOf(value: unknown, max: number, fallback = ''): string {
  return isStr(value) ? scrubString(value, max) : fallback;
}

function stringsOf(value: unknown, max: number, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isStr).slice(0, limit).map((item) => scrubString(item, max));
}

/** Đường dẫn file tương đối trong dự án; sai thì null và ghi cảnh báo. */
function pathOf(value: unknown, warnings: string[]): string | null {
  if (!isStr(value) || value === '') return null;
  const unsafe = value.length > LIMITS.path || value.startsWith('/') || value.includes('\\')
    || value.split('/').includes('..') || /^[A-Za-z]:/.test(value);
  if (unsafe) {
    warnings.push('Skipped a file path that is not relative or is too long');
    return null;
  }
  return scrubString(value, LIMITS.path);
}

function fieldOf(value: unknown, depth: number, warnings: string[]): SchemaField | null {
  if (!isObj(value)) return null;
  const name = strOf(value.name, LIMITS.name);
  if (name === '') return null;
  const rawChildren = Array.isArray(value.children) ? value.children : [];
  const children = depth < LIMITS.fieldDepth
    ? rawChildren.slice(0, LIMITS.childrenPerField).map((child) => fieldOf(child, depth + 1, warnings)).filter((child): child is SchemaField => child !== null)
    : [];
  return {
    name,
    type: strOf(value.type, LIMITS.type, 'mixed'),
    required: value.required === true,
    pk: value.pk === true,
    array: value.array === true,
    inferred: value.inferred === true,
    children,
  };
}

function indexOf(value: unknown): SchemaIndex | null {
  if (!isObj(value)) return null;
  const keys = stringsOf(value.keys, LIMITS.name, LIMITS.keysPerIndex);
  return { name: strOf(value.name, LIMITS.name, keys.join('_')), keys, unique: value.unique === true, ttl: value.ttl === true };
}

function collectionOf(value: unknown, origin: 'static' | 'agent', warnings: string[]): SchemaCollection | null {
  if (!isObj(value)) return null;
  const name = strOf(value.name, LIMITS.name);
  if (name === '') return null;
  const rawFields = Array.isArray(value.fields) ? value.fields : [];
  if (rawFields.length > LIMITS.fieldsPerCollection) warnings.push(`${name}: only the first ${LIMITS.fieldsPerCollection} fields are kept`);
  const fields = rawFields.slice(0, LIMITS.fieldsPerCollection).map((f) => fieldOf(f, 1, warnings)).filter((f): f is SchemaField => f !== null);
  const rawIndexes = Array.isArray(value.indexes) ? value.indexes : [];
  const indexes = rawIndexes.slice(0, LIMITS.indexesPerCollection).map(indexOf).filter((i): i is SchemaIndex => i !== null);
  return {
    name,
    model: isStr(value.model) ? strOf(value.model, LIMITS.name) : null,
    file: pathOf(value.file, warnings),
    orm: strOf(value.orm, 64, 'unknown'),
    confidence: value.confidence === 'declared' ? 'declared' : 'inferred',
    origin,
    fields,
    indexes,
  };
}

function relationOf(value: unknown): SchemaRelation | null {
  if (!isObj(value)) return null;
  const from = strOf(value.from, LIMITS.name);
  const to = strOf(value.to, LIMITS.name);
  if (from === '' || to === '' || !isStr(value.kind) || !RELATION_KINDS.has(value.kind)) return null;
  return {
    from,
    to,
    field: isStr(value.field) ? strOf(value.field, LIMITS.name) : null,
    kind: value.kind as SchemaRelation['kind'],
    confidence: value.confidence === 'declared' ? 'declared' : 'inferred',
  };
}

/** Báo cáo rỗng, dùng khi không có gì để trả về. */
export function emptyReport(kind: SchemaReport['source']['kind'], warnings: string[] = []): SchemaReport {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: { kind, detectors: [] },
    truncated: false,
    warnings: warnings.slice(0, LIMITS.warnings),
    collections: [],
    relations: [],
  };
}

/**
 * Kiểm tra và làm sạch một báo cáo từ bên ngoài (agent hoặc file cũ). Không ném lỗi.
 *
 * Args:
 *   input: Giá trị JSON đã parse.
 *   origin: 'static' khi do service quét, 'agent' khi do agent ghi.
 *
 * Returns:
 *   Báo cáo đã làm sạch (hoặc null nếu không dùng được) và các cảnh báo.
 */
export function validateReport(input: unknown, origin: 'static' | 'agent' = 'static'): { report: SchemaReport | null; warnings: string[] } {
  if (!isObj(input) || input.version !== 1) {
    return { report: null, warnings: ['The report is not in the v1 format'] };
  }
  const warnings: string[] = [];
  const rawCollections = Array.isArray(input.collections) ? input.collections : [];
  if (rawCollections.length > LIMITS.collections) warnings.push(`Only the first ${LIMITS.collections} collections are kept`);
  const collections = rawCollections
    .slice(0, LIMITS.collections)
    .map((c) => collectionOf(c, origin, warnings))
    .filter((c): c is SchemaCollection => c !== null);
  const rawRelations = Array.isArray(input.relations) ? input.relations : [];
  const relations = rawRelations.slice(0, LIMITS.relations).map(relationOf).filter((r): r is SchemaRelation => r !== null);
  const report: SchemaReport = {
    version: 1,
    generatedAt: strOf(input.generatedAt, 40, new Date(0).toISOString()),
    source: { kind: origin, detectors: stringsOf(isObj(input.source) ? input.source.detectors : [], 64, 20) },
    truncated: input.truncated === true || rawCollections.length > LIMITS.collections,
    warnings: [...warnings, ...stringsOf(input.warnings, 200, LIMITS.warnings)].slice(0, LIMITS.warnings),
    collections,
    relations,
  };
  if (Buffer.byteLength(JSON.stringify(report)) > LIMITS.bytes) {
    return { report: null, warnings: ['The report is too large (over 512 KB), skipped'] };
  }
  return { report, warnings: report.warnings };
}

function mergeFields(primary: SchemaField[], secondary: SchemaField[]): SchemaField[] {
  const byName = new Map<string, SchemaField>();
  for (const field of primary) byName.set(field.name, field);
  for (const field of secondary) {
    const existing = byName.get(field.name);
    if (!existing) {
      byName.set(field.name, field);
      continue;
    }
    byName.set(field.name, {
      ...existing,
      type: existing.type === 'mixed' ? field.type : existing.type,
      required: existing.required || field.required,
      pk: existing.pk || field.pk,
      array: existing.array || field.array,
      inferred: existing.inferred && field.inferred,
      children: existing.children.length > 0 ? existing.children : field.children,
    });
  }
  return [...byName.values()].slice(0, LIMITS.fieldsPerCollection);
}

function mergeTwo(a: SchemaCollection, b: SchemaCollection): SchemaCollection {
  const aDeclared = a.confidence === 'declared';
  const bDeclared = b.confidence === 'declared';
  const primary = aDeclared || !bDeclared ? a : b;
  const secondary = primary === a ? b : a;
  const indexes = new Map<string, SchemaIndex>();
  for (const index of [...primary.indexes, ...secondary.indexes]) if (!indexes.has(index.name)) indexes.set(index.name, index);
  return {
    name: a.name,
    model: primary.model ?? secondary.model,
    file: primary.file ?? secondary.file,
    orm: primary.orm,
    confidence: aDeclared || bDeclared ? 'declared' : 'inferred',
    origin: a.origin === 'static' || b.origin === 'static' ? 'static' : 'agent',
    fields: mergeFields(primary.fields, secondary.fields),
    indexes: [...indexes.values()].slice(0, LIMITS.indexesPerCollection),
  };
}

/** Gộp các collection cùng tên; khai báo thắng suy đoán, field gộp theo tên. */
export function mergeCollections(list: SchemaCollection[]): SchemaCollection[] {
  const byName = new Map<string, SchemaCollection>();
  for (const item of list) {
    const existing = byName.get(item.name);
    byName.set(item.name, existing ? mergeTwo(existing, item) : item);
  }
  return [...byName.values()].slice(0, LIMITS.collections);
}

/** Gộp quan hệ: bỏ trùng; khi trùng thì giữ bản khai báo. */
export function mergeRelations(list: SchemaRelation[]): SchemaRelation[] {
  const byKey = new Map<string, SchemaRelation>();
  for (const relation of list) {
    const key = `${relation.from}|${relation.to}|${relation.field ?? ''}|${relation.kind}`;
    const existing = byKey.get(key);
    if (!existing || (relation.confidence === 'declared' && existing.confidence === 'inferred')) byKey.set(key, relation);
  }
  return [...byKey.values()].slice(0, LIMITS.relations);
}

/**
 * Gộp báo cáo quét tĩnh với báo cáo của agent.
 *
 * Args:
 *   base: Báo cáo nền (quét tĩnh).
 *   extra: Báo cáo của agent, hoặc null.
 *
 * Returns:
 *   Báo cáo gộp (nguồn "merged"), hoặc chính base nếu không có extra.
 */
export function combineReports(base: SchemaReport, extra: SchemaReport | null): SchemaReport {
  if (extra === null) return base;
  const collections = mergeCollections([...base.collections, ...extra.collections]);
  const warnings = [...new Set([...base.warnings, ...extra.warnings])].slice(0, LIMITS.warnings);
  return {
    version: 1,
    generatedAt: base.generatedAt,
    source: { kind: 'merged', detectors: [...new Set([...base.source.detectors, ...extra.source.detectors])] },
    truncated: base.truncated || extra.truncated || collections.length >= LIMITS.collections,
    warnings,
    collections,
    relations: mergeRelations([...base.relations, ...extra.relations]),
  };
}
