/**
 * Detector laravel-mongodb: lớp Eloquent (kết nối MongoDB qua laravel-mongodb) và file tạo index.
 * - Model: class extends *Model, không abstract. Collection từ $table; không có thì snake của tên lớp (suy đoán).
 * - Field: $fillable (kiểu chưa rõ, suy đoán), $casts (kiểu khai báo). Lớp extends BaseModel thêm _id và timestamp.
 * - Quan hệ: $this->belongsTo(X::class, 'khoa') và các hàm quan hệ tương tự, trong thân hàm.
 * - Index: getCollection('x') rồi $this->create($collection, [keys], [options]) trong cùng file.
 * Giới hạn: đọc thân hàm đến dấu "}" đầu tiên; không hiểu code động (forTable chỉ được cảnh báo).
 */
import type { SchemaRelation } from '../../shared/api.ts';
import { collectionOf, type Detector, type Draft, emptyDraft, fieldOf, indexOf, insideOf, lastSegment, quotedIn, snakeOf } from './common.ts';

const CLASS = /^\s*(abstract\s+)?(?:final\s+)?class\s+(\w+)\s+extends\s+\\?([\w\\]+)/m;
const TABLE = /\$table\s*=\s*['"]([^'"]+)['"]/;
const RELATION_FN = /function\s+(\w+)\s*\([^)]*\)\s*(?::\s*[\w\\?]+\s*)?\{/g;
const RELATION_CALL = /\$this->(belongsTo|hasMany|hasOne|belongsToMany)\(\s*\\?([\w\\]+)::class\s*(?:,\s*['"]([^'"]+)['"])?/;
const KIND: Record<string, SchemaRelation['kind']> = {
  belongsTo: 'belongsTo',
  hasMany: 'hasMany',
  hasOne: 'hasOne',
  belongsToMany: 'belongsToMany',
};

type Pending = { from: string; target: string; kind: SchemaRelation['kind']; field: string | null };

function arrayBody(body: string, key: RegExp): string | null {
  const match = key.exec(body);
  if (!match) return null;
  return insideOf(body, match.index + match[0].length - 1);
}

function fieldsOf(body: string, base: string) {
  const fields = new Map<string, ReturnType<typeof fieldOf>>();
  if (base === 'BaseModel') {
    fields.set('_id', fieldOf('_id', 'ObjectId', { pk: true }));
    fields.set('createdAt', fieldOf('createdAt', 'number'));
    fields.set('updatedAt', fieldOf('updatedAt', 'number'));
  }
  for (const name of [...(arrayBody(body, /\$fillable\s*=\s*\[/) ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] as string)) {
    if (!fields.has(name)) fields.set(name, fieldOf(name, 'mixed', { inferred: true }));
  }
  for (const cast of (arrayBody(body, /\$casts\s*=\s*\[/) ?? '').matchAll(/['"]([^'"]+)['"]\s*=>\s*['"]?([\w:]+)['"]?/g)) {
    fields.set(cast[1] as string, fieldOf(cast[1] as string, cast[2] as string));
  }
  return [...fields.values()];
}

function relationsOf(body: string, from: string): Pending[] {
  const pending: Pending[] = [];
  for (const fn of body.matchAll(RELATION_FN)) {
    const inner = insideOf(body, (fn.index ?? 0) + fn[0].length - 1);
    const call = RELATION_CALL.exec(inner);
    if (!call) continue;
    const kind = KIND[call[1] as string] as SchemaRelation['kind'];
    const explicit = call[3] ?? null;
    const field = explicit ?? (kind === 'belongsTo' ? `${fn[1]}_id` : null);
    pending.push({ from, target: lastSegment(call[2] as string), kind, field });
  }
  return pending;
}

function modelsOf(file: { rel: string; text: string }, draft: Draft, classNames: Map<string, string>, pending: Pending[]): void {
  const match = CLASS.exec(file.text);
  if (!match || match[1] !== undefined || !lastSegment(match[3] as string).endsWith('Model')) return;
  const className = match[2] as string;
  const base = lastSegment(match[3] as string);
  const openBrace = file.text.indexOf('{', match.index + match[0].length);
  const body = openBrace === -1 ? '' : insideOf(file.text, openBrace);
  const table = TABLE.exec(body)?.[1] ?? null;
  const name = table ?? snakeOf(className);
  classNames.set(className, name);
  if (/function\s+forTable\b/.test(body)) {
    draft.warnings.push(`laravel-mongodb: ${className} đổi collection lúc chạy (forTable), chỉ ghi bảng gốc ${name}`);
  }
  draft.collections.push(collectionOf({
    name,
    model: className,
    file: file.rel,
    orm: 'laravel-mongodb',
    confidence: table ? 'declared' : 'inferred',
    fields: fieldsOf(body, base),
  }));
  pending.push(...relationsOf(body, name));
}

function indexesOf(file: { rel: string; text: string }, draft: Draft): void {
  const collection = quotedIn(/getCollection\(\s*['"][^'"]+['"]\s*\)/.exec(file.text)?.[0] ?? '');
  if (collection === null) return;
  const indexes = [...file.text.matchAll(/\$this->create\(\s*\$\w+\s*,\s*\[([^\]]*)\]\s*(?:,\s*\[([^\]]*)\])?/g)].map((call) => {
    const keys = [...(call[1] ?? '').matchAll(/['"]([^'"]+)['"]\s*=>/g)].map((m) => m[1] as string);
    const options = call[2] ?? '';
    const name = /['"]name['"]\s*=>\s*['"]([^'"]+)['"]/.exec(options)?.[1];
    return indexOf(keys, {
      name: name ?? keys.join('_'),
      unique: /['"]unique['"]\s*=>\s*true/.test(options),
      ttl: /expireAfterSeconds/.test(options),
    });
  });
  if (indexes.length === 0) return;
  draft.collections.push(collectionOf({ name: collection, file: file.rel, orm: 'laravel-mongodb', confidence: 'declared', indexes }));
}

export const laravelDetector: Detector = {
  id: 'laravel-mongodb',
  detect(files) {
    const draft = emptyDraft();
    const classNames = new Map<string, string>();
    const pending: Pending[] = [];
    for (const file of files) {
      if (!file.rel.endsWith('.php')) continue;
      modelsOf(file, draft, classNames, pending);
      indexesOf(file, draft);
    }
    for (const item of pending) {
      const to = classNames.get(item.target) ?? snakeOf(item.target);
      draft.relations.push({ from: item.from, to, field: item.field, kind: item.kind, confidence: 'declared' });
    }
    return draft;
  },
};
