/**
 * Menu @ của composer: làm nóng cache khi service khởi động và mô tả một collection
 * cho agent khi người dùng chọn một row.
 */
import { BSON, type Db } from 'mongodb';

import type { MentionsResolveResult } from '@openchamber/sdk';

import { badRequest, notFound, toHttpError } from './errors.ts';
import { numberOf } from './ejson.ts';
import { maskSensitive } from './mask.ts';
import { decodeMentionId, rememberCollections, searchMentions } from './mentions-cache.ts';
import { clientFor, withDatabase } from './pool.ts';
import { type ConnectionRecord, listConnections } from './store.ts';
import { type Body, requireString } from './validate.ts';

const MAX_TEXT = 16000;
const SAMPLE_SIZE = 100;
const EXAMPLE_COUNT = 3;
const EXAMPLE_CHARS = 2000;
const WARM_DATABASES = 50;
const WARM_COLLECTIONS = 500;
const MAX_FIELD_DEPTH = 3;
const { EJSON } = BSON;

/** Nạp danh sách database và collection của một connection vào cache; lỗi bị bỏ qua. */
export async function warmConnection(record: ConnectionRecord): Promise<void> {
  try {
    const client = await clientFor(record);
    const listed = await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
    let budget = WARM_COLLECTIONS;
    for (const info of listed.databases.slice(0, WARM_DATABASES)) {
      if (budget <= 0) break;
      const names = await client.db(info.name).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
      const picked = names.slice(0, budget).map((item) => ({ name: item.name, type: 'collection' as const, count: null }));
      budget -= picked.length;
      rememberCollections(record.id, record.name, info.name, picked);
    }
  } catch {
    // Chưa kết nối được thì menu @ chỉ thiếu các row của connection này; không cần báo lỗi.
  }
}

/** Làm nóng cache cho mọi connection đã lưu, không chờ kết quả. */
export function warmAllConnections(): void {
  void listConnections().then((records) => Promise.all(records.map((record) => warmConnection(record))));
}

/** Route /mentions/search: chỉ đọc cache, không gọi MongoDB. */
export function searchRoute(body: Body): ReturnType<typeof searchMentions> {
  return searchMentions(typeof body.query === 'string' ? body.query : '');
}

/** Route /mentions/resolve: mô tả collection được chọn để đưa vào ngữ cảnh của agent. */
export async function resolveRoute(body: Body): Promise<MentionsResolveResult> {
  const ref = decodeMentionId(requireString(body, 'id', 256));
  if (!ref) throw badRequest('Row này không còn hợp lệ. Mở lại menu @ rồi chọn lại.');
  const record = (await listConnections()).find((item) => item.id === ref.connectionId);
  if (!record) throw notFound('Connection của row này đã bị xoá. Mở lại menu @ rồi chọn lại.');
  const text = await withDatabase(record, ref.database, (db) =>
    describeCollection(db, record, ref.database, ref.collection));
  return { text };
}

async function describeCollection(
  db: Db,
  record: ConnectionRecord,
  database: string,
  collection: string,
): Promise<string> {
  const coll = db.collection(collection);
  const [count, indexes, sample] = await Promise.all([
    coll.estimatedDocumentCount({ maxTimeMS: 5000 }).then(numberOf, () => null),
    coll.indexes().catch(() => []),
    coll.find({}, { limit: SAMPLE_SIZE }).toArray().catch((error: unknown) => {
      throw toHttpError(error, record.uri);
    }),
  ]);
  const lines = [
    `Collection ${database}.${collection} (connection "${record.name}")`,
    `Access: ${record.readOnly ? 'read-only, writes are blocked' : 'read-write'}`,
    `Estimated documents: ${count ?? 'unknown'}`,
    '',
    'Indexes:',
    ...indexes.map((index) => `- ${String(index.name)}: ${JSON.stringify(EJSON.serialize(index.key, { relaxed: true }))}${index.unique ? ' (unique)' : ''}`),
    '',
    `Fields (from up to ${sample.length} sampled documents):`,
    ...fieldLines(sample),
    '',
    `Sample documents (up to ${EXAMPLE_COUNT}, sensitive values masked):`,
    ...sample.slice(0, EXAMPLE_COUNT).map((doc, i) => `${i + 1}. ${exampleText(doc)}`),
  ];
  return clip(lines.join('\n'));
}

function exampleText(doc: unknown): string {
  const text = JSON.stringify(maskSensitive(EJSON.serialize(doc as Record<string, unknown>, { relaxed: true })));
  return text.length > EXAMPLE_CHARS ? `${text.slice(0, EXAMPLE_CHARS)}...(cut)` : text;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 40)}\n...(đã cắt bớt)` : text;
}

/** Tên kiểu BSON của một giá trị, ví dụ objectId, date, string, array. */
export function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (typeof value === 'object') return (value as { _bsontype?: string })._bsontype ?? 'object';
  return typeof value;
}

/** Thu thập kiểu của mọi field (lồng tối đa 3 cấp) từ các document mẫu. */
export function inferFields(docs: unknown[]): Map<string, Set<string>> {
  const types = new Map<string, Set<string>>();
  const visit = (value: unknown, prefix: string, depth: number): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || depth >= MAX_FIELD_DEPTH) return;
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const set = types.get(path) ?? new Set<string>();
      set.add(typeOf(child));
      types.set(path, set);
      visit(child, path, depth + 1);
    }
  };
  docs.forEach((doc) => visit(doc, '', 0));
  return types;
}

function fieldLines(docs: unknown[]): string[] {
  const types = inferFields(docs);
  if (types.size === 0) return ['(no documents)'];
  return [...types.keys()].sort().map((path) => `- ${path}: ${[...(types.get(path) ?? [])].sort().join(', ')}`);
}
