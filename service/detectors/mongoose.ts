/**
 * Detector mongoose: new Schema({...}, {collection?}) + mongoose.model('Name', schema).
 * - Collection: option collection, không có thì số nhiều chữ thường của tên model (suy đoán).
 * - Field: type (lấy phần cuối, ví dụ Schema.Types.ObjectId → ObjectId), required, mảng [X]. Object lồng không đệ quy.
 * - ref: 'Model' → quan hệ khai báo (reference).
 * - schema.index({...}, {unique}) → index.
 * Giới hạn: chỉ schema khai báo trực tiếp bằng new Schema; không theo import giữa các file.
 */
import type { SchemaField, SchemaIndex } from '../../shared/api.ts';
import {
  closeIndex,
  collectionOf,
  type Detector,
  type Draft,
  emptyDraft,
  fieldOf,
  indexOf,
  insideOf,
  lastSegment,
  pluralOf,
  quotedIn,
  splitTop,
} from './common.ts';

type SchemaInfo = { fields: SchemaField[]; indexes: SchemaIndex[]; collection: string | null; refs: Array<{ field: string; model: string }> };

const SCHEMA = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(/g;
const MODEL = /(?:mongoose\.)?model\s*\(\s*['"](\w+)['"]\s*,\s*(\w+)/g;

function typeOf(value: string): string {
  const object = value.startsWith('{') ? insideOf(value, 0) : null;
  if (object !== null) {
    const declared = /\btype\s*:\s*([\w.]+)/.exec(object)?.[1];
    return declared === undefined ? 'mixed' : lastSegment(declared);
  }
  return lastSegment(value.replace(/[\[\]{}]/g, '').trim()) || 'mixed';
}

function fieldFrom(key: string, raw: string, info: SchemaInfo): void {
  let value = raw;
  let array = false;
  if (value.startsWith('[')) {
    array = true;
    value = splitTop(insideOf(value, 0))[0] ?? 'Mixed';
  }
  const object = value.startsWith('{') ? insideOf(value, 0) : '';
  const ref = quotedIn(/\bref\s*:\s*['"][^'"]+['"]/.exec(object)?.[0] ?? '');
  if (ref !== null) info.refs.push({ field: key, model: ref });
  info.fields.push(fieldOf(key, typeOf(value), {
    array,
    required: /\brequired\s*:\s*true/.test(object),
    pk: key === '_id',
  }));
}

function schemaOf(text: string, match: RegExpExecArray): SchemaInfo {
  const open = match.index + match[0].length - 1;
  const args = splitTop(insideOf(text, open));
  const info: SchemaInfo = { fields: [], indexes: [], collection: null, refs: [] };
  const body = args[0]?.startsWith('{') ? insideOf(args[0], 0) : '';
  for (const entry of splitTop(body)) {
    const colon = entry.indexOf(':');
    if (colon === -1) continue;
    const key = entry.slice(0, colon).trim().replace(/['"]/g, '');
    if (key !== '') fieldFrom(key, entry.slice(colon + 1).trim(), info);
  }
  const options = args[1] ?? '';
  info.collection = quotedIn(/\bcollection\s*:\s*['"][^'"]+['"]/.exec(options)?.[0] ?? '');
  return info;
}

function indexesIn(text: string, variable: string): SchemaIndex[] {
  const indexes: SchemaIndex[] = [];
  const calls = new RegExp(`${variable}\\.index\\s*\\(`, 'g');
  for (const call of text.matchAll(calls)) {
    const open = (call.index ?? 0) + call[0].length - 1;
    const close = closeIndex(text, open);
    if (close === -1) continue;
    const inner = text.slice(open + 1, close);
    const keyPart = splitTop(inner)[0] ?? '';
    const keys = [...keyPart.matchAll(/['"]?([\w.]+)['"]?\s*:\s*-?1/g)].map((m) => m[1] as string);
    if (keys.length > 0) indexes.push(indexOf(keys, { unique: /\bunique\s*:\s*true/.test(inner) }));
  }
  return indexes;
}

export const mongooseDetector: Detector = {
  id: 'mongoose',
  detect(files) {
    const draft: Draft = emptyDraft();
    const models = new Map<string, string>();
    const pending: Array<{ from: string; field: string; model: string }> = [];
    for (const file of files) {
      if (!/\.(js|ts|mjs)$/.test(file.rel) || !/mongoose/.test(file.text)) continue;
      const schemas = new Map<string, SchemaInfo>();
      for (const match of file.text.matchAll(SCHEMA)) {
        schemas.set(match[1] as string, schemaOf(file.text, match));
      }
      for (const match of file.text.matchAll(MODEL)) {
        const modelName = match[1] as string;
        const variable = match[2] as string;
        const info = schemas.get(variable);
        if (!info) continue;
        const name = info.collection ?? pluralOf(modelName);
        models.set(modelName, name);
        draft.collections.push(collectionOf({
          name,
          model: modelName,
          file: file.rel,
          orm: 'mongoose',
          confidence: info.collection ? 'declared' : 'inferred',
          fields: info.fields,
          indexes: indexesIn(file.text, variable),
        }));
        for (const ref of info.refs) pending.push({ from: name, field: ref.field, model: ref.model });
      }
    }
    for (const item of pending) {
      const to = models.get(item.model) ?? pluralOf(item.model);
      draft.relations.push({ from: item.from, to, field: item.field, kind: 'reference', confidence: 'declared' });
    }
    return draft;
  },
};
