/**
 * Detector jsonschema: file .json có khoá $jsonSchema (validator của MongoDB).
 * - Collection: khoá collection/create gần nhất trong cây JSON; không có thì tên file (suy đoán).
 * - Field: properties (bsonType, required); object lồng tối đa 3 cấp; array chỉ đánh dấu là mảng.
 * JSON được parse bằng JSON.parse; không thực thi gì.
 */
import type { SchemaField } from '../../shared/api.ts';
import { collectionOf, type Detector, type Draft, emptyDraft, fieldOf } from './common.ts';

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_DEPTH = 6;
const MAX_FIELDS = 100;

function fieldsOf(schema: Obj, depth: number): SchemaField[] {
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []);
  const properties = isObj(schema.properties) ? schema.properties : {};
  return Object.entries(properties).slice(0, MAX_FIELDS).map(([name, spec]) => {
    const node = isObj(spec) ? spec : {};
    const bson = node.bsonType ?? node.type;
    const type = Array.isArray(bson)
      ? bson.filter((item): item is string => typeof item === 'string').join('|')
      : typeof bson === 'string' ? bson : 'mixed';
    const children = depth < 3 && isObj(node.properties) ? fieldsOf(node, depth + 1) : [];
    return fieldOf(name, type.slice(0, 64), { required: required.has(name), array: type === 'array', children });
  });
}

type Found = { explicit: string | null; schema: Obj };

function walk(node: unknown, explicit: string | null, depth: number, out: Found[]): void {
  if (depth > MAX_DEPTH || typeof node !== 'object' || node === null) return;
  let name = explicit;
  if (isObj(node)) {
    const declared = typeof node.collection === 'string' ? node.collection : typeof node.create === 'string' ? node.create : null;
    if (declared !== null) name = declared;
    if (isObj(node.$jsonSchema)) out.push({ explicit: name, schema: node.$jsonSchema });
  }
  for (const child of Object.values(node)) walk(child, name, depth + 1, out);
}

export const jsonschemaDetector: Detector = {
  id: 'jsonschema',
  detect(files) {
    const draft: Draft = emptyDraft();
    for (const file of files) {
      if (!file.rel.endsWith('.json') || !file.text.includes('$jsonSchema')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.text);
      } catch {
        draft.warnings.push(`jsonschema: ${file.rel} is not valid JSON, skipped`);
        continue;
      }
      const found: Found[] = [];
      walk(parsed, null, 0, found);
      const base = (file.rel.split('/').pop() ?? file.rel).replace(/\.json$/, '');
      for (const item of found) {
        draft.collections.push(collectionOf({
          name: item.explicit ?? base,
          file: file.rel,
          orm: 'jsonschema',
          confidence: item.explicit ? 'declared' : 'inferred',
          fields: fieldsOf(item.schema, 1),
        }));
      }
    }
    return draft;
  },
};
