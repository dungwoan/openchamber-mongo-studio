/**
 * Chạy một lệnh đã parse trên database của driver. Mọi kết quả đều ở dạng Extended JSON canonical.
 * Find và aggregate cắt ở 500 dòng; các lệnh ghi trả về số liệu tóm tắt.
 */
import type { Db, Document, Filter, FindOptions } from 'mongodb';

import type { QueryKind } from '../shared/api.ts';
import type { Command } from '../shared/query-parser.ts';
import { numberOf, toBson, toJson } from './ejson.ts';

export const MAX_ROWS = 500;
const MAX_TIME_MS = 30000;

/** Kết quả thô trước khi gói thành QueryResponse. */
export type ExecOutcome = {
  kind: QueryKind;
  result: unknown;
  count: number | null;
  truncated: boolean;
};

/** Giới hạn dòng thực tế: mặc định và trần đều là 500; limit(0) cũng dùng mặc định. */
export function effectiveLimit(limit: number | undefined): number {
  return limit !== undefined && limit > 0 ? Math.min(limit, MAX_ROWS) : MAX_ROWS;
}

function listOutcome(kind: QueryKind, items: unknown[], limit: number): ExecOutcome {
  const truncated = items.length > limit;
  const kept = items.slice(0, limit).map(toJson);
  return { kind, result: kept, count: kept.length, truncated };
}

function scalarOutcome(kind: QueryKind, result: unknown): ExecOutcome {
  return { kind, result: toJson(result), count: null, truncated: false };
}

/** Đổi đối tượng tuỳ chọn không bắt buộc sang BSON, giữ undefined nếu không có. */
function optionalBson(value: Document | undefined): Document | undefined {
  return value === undefined ? undefined : (toBson(value) as Document);
}

/**
 * Chạy lệnh và trả về kết quả đã serialize.
 *
 * Args:
 *   db: Database đã chọn.
 *   command: Lệnh đã được parseQuery kiểm tra.
 *
 * Returns:
 *   Kết quả và thông tin cắt dòng.
 *
 * Raises:
 *   Lỗi của driver khi MongoDB từ chối thao tác.
 */
export async function executeCommand(db: Db, command: Command): Promise<ExecOutcome> {
  switch (command.kind) {
    case 'find':
      return runFind(db, command);
    case 'findOne': {
      const doc = await db.collection(command.collection).findOne(
        toBson(command.filter) as Filter<Document>,
        { projection: optionalBson(command.projection), maxTimeMS: MAX_TIME_MS },
      );
      return scalarOutcome('findOne', doc);
    }
    case 'count':
      return scalarOutcome('count', numberOf(await db.collection(command.collection).countDocuments(
        toBson(command.filter) as Filter<Document>,
        { maxTimeMS: MAX_TIME_MS },
      )));
    case 'distinct':
      return runDistinct(db, command);
    case 'aggregate':
      return runAggregate(db, command);
    case 'insertOne':
    case 'insertMany':
    case 'updateOne':
    case 'updateMany':
    case 'deleteOne':
    case 'deleteMany':
      return runWrite(db, command);
    case 'collectionNames':
      return runCollectionNames(db);
    case 'stats':
      return scalarOutcome('stats', await db.stats());
  }
}

async function runFind(db: Db, command: Extract<Command, { kind: 'find' }>): Promise<ExecOutcome> {
  const limit = effectiveLimit(command.limit);
  const options: FindOptions = {
    projection: optionalBson(command.projection),
    sort: optionalBson(command.sort),
    skip: command.skip,
    limit: limit + 1,
    maxTimeMS: MAX_TIME_MS,
  };
  const docs = await db.collection(command.collection).find(toBson(command.filter) as Filter<Document>, options).toArray();
  return listOutcome('find', docs, limit);
}

async function runDistinct(db: Db, command: Extract<Command, { kind: 'distinct' }>): Promise<ExecOutcome> {
  const values = await db.collection(command.collection).distinct(
    command.field,
    toBson(command.filter) as Filter<Document>,
    { maxTimeMS: MAX_TIME_MS },
  );
  return listOutcome('distinct', values, MAX_ROWS);
}

async function runAggregate(db: Db, command: Extract<Command, { kind: 'aggregate' }>): Promise<ExecOutcome> {
  const pipeline = command.stages.map((stage) => toBson(stage) as Document);
  const writes = pipeline.some((stage) => '$out' in stage || '$merge' in stage);
  // $limit cuối pipeline chặn kết quả lớn; không thêm khi có $out/$merge vì $out phải là stage cuối.
  if (!writes) pipeline.push({ $limit: MAX_ROWS + 1 });
  const docs = await db.collection(command.collection).aggregate(pipeline, {
    allowDiskUse: command.options.allowDiskUse ?? false,
    maxTimeMS: command.options.maxTimeMS ?? MAX_TIME_MS,
  }).toArray();
  return listOutcome('aggregate', docs, MAX_ROWS);
}

async function runWrite(db: Db, command: Command): Promise<ExecOutcome> {
  const collectionOf = (name: string): ReturnType<Db['collection']> => db.collection(name);
  switch (command.kind) {
    case 'insertOne': {
      const r = await collectionOf(command.collection).insertOne(toBson(command.document) as Document);
      return scalarOutcome('insertOne', { acknowledged: r.acknowledged, insertedId: r.insertedId });
    }
    case 'insertMany': {
      const docs = command.documents.map((doc) => toBson(doc) as Document);
      const r = await collectionOf(command.collection).insertMany(docs);
      return scalarOutcome('insertMany', { insertedCount: numberOf(r.insertedCount), insertedIds: r.insertedIds });
    }
    case 'updateOne':
    case 'updateMany': {
      const filter = toBson(command.filter) as Filter<Document>;
      const update = toBson(command.update) as Document;
      const r = command.kind === 'updateOne'
        ? await collectionOf(command.collection).updateOne(filter, update)
        : await collectionOf(command.collection).updateMany(filter, update);
      return scalarOutcome(command.kind, {
        matchedCount: numberOf(r.matchedCount),
        modifiedCount: numberOf(r.modifiedCount),
        upsertedId: r.upsertedId ?? null,
      });
    }
    case 'deleteOne':
    case 'deleteMany': {
      const filter = toBson(command.filter) as Filter<Document>;
      const r = command.kind === 'deleteOne'
        ? await collectionOf(command.collection).deleteOne(filter)
        : await collectionOf(command.collection).deleteMany(filter);
      return scalarOutcome(command.kind, { deletedCount: numberOf(r.deletedCount) });
    }
    default:
      throw new Error(`Lệnh ${command.kind} không phải lệnh ghi`);
  }
}

async function runCollectionNames(db: Db): Promise<ExecOutcome> {
  const items = await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
  const names = items.map((item) => item.name).sort();
  return listOutcome('collectionNames', names, MAX_ROWS);
}
