/**
 * Route duyệt cây database/collection và xem document (có filter, sort, phân trang).
 */
import type { Document, Filter } from 'mongodb';

import type {
  CollectionInfo,
  CollectionsResponse,
  DatabasesResponse,
  FindResponse,
  IndexesResponse,
} from '../../shared/api.ts';
import { fitToBudget, numberOf, toBson, toJson, toRelaxed } from '../ejson.ts';
import { rememberCollections } from '../mentions-cache.ts';
import { withDatabase } from '../pool.ts';
import { type Body, optionalInteger, optionalString, requireString } from '../validate.ts';
import { connectionFrom, mapWithLimit, optionalObjectLiteral, RESPONSE_BUDGET } from './common.ts';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;
const COUNT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 30000;
const COUNT_CONCURRENCY = 8;

/** Route /tree/databases. */
export async function databasesRoute(body: Body): Promise<DatabasesResponse> {
  const record = await connectionFrom(body);
  const listed = await withDatabase(record, 'admin', (db) =>
    db.admin().listDatabases({ nameOnly: false, authorizedDatabases: true }));
  const databases = listed.databases.map((info) => ({
    name: info.name,
    sizeOnDisk: numberOf(info.sizeOnDisk),
    empty: info.empty === true,
  }));
  return { databases: databases.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Route /tree/collections: liệt kê collection và đếm document ước tính. */
export async function collectionsRoute(body: Body): Promise<CollectionsResponse> {
  const record = await connectionFrom(body);
  const database = requireString(body, 'database', 255);
  const collections = await withDatabase(record, database, async (db): Promise<CollectionInfo[]> => {
    const listed = await db.listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray();
    return mapWithLimit(listed, COUNT_CONCURRENCY, async (item) => {
      const type = item.type === 'view' ? 'view' : 'collection';
      const count = type === 'view'
        ? null
        : numberOf(await db.collection(item.name).estimatedDocumentCount({ maxTimeMS: COUNT_TIMEOUT_MS }).catch(() => null));
      return { name: item.name, type, count };
    });
  });
  const sorted = collections.sort((a, b) => a.name.localeCompare(b.name));
  rememberCollections(record.id, record.name, database, sorted);
  return { collections: sorted };
}

/** Route /collection/find: filter, sort, projection, skip, limit (mặc định 50, tối đa 500). */
export async function findRoute(body: Body): Promise<FindResponse> {
  const record = await connectionFrom(body);
  const database = requireString(body, 'database', 255);
  const collection = requireString(body, 'collection', 255);
  const filter = (optionalObjectLiteral(optionalString(body, 'filter'), 'Filter') ?? {}) as Document;
  const sort = optionalObjectLiteral(optionalString(body, 'sort'), 'Sort');
  const projection = optionalObjectLiteral(optionalString(body, 'projection'), 'Projection');
  const skip = optionalInteger(body, 'skip', 0, 1_000_000_000) ?? 0;
  const limit = optionalInteger(body, 'limit', 1, MAX_PAGE) ?? DEFAULT_PAGE;

  const started = Date.now();
  return withDatabase(record, database, async (db) => {
    const coll = db.collection(collection);
    const query = toBson(filter) as Filter<Document>;
    const [docs, total] = await Promise.all([
      coll.find(query, {
        sort: sort ? (toBson(sort) as Document) : undefined,
        projection: projection ? (toBson(projection) as Document) : undefined,
        skip,
        limit,
        maxTimeMS: QUERY_TIMEOUT_MS,
      }).toArray(),
      coll.countDocuments(query, { maxTimeMS: COUNT_TIMEOUT_MS }).then(numberOf, () => null),
    ]);
    const fitted = fitToBudget(docs.map(toJson), RESPONSE_BUDGET);
    return {
      docs: fitted.items,
      total,
      elapsedMs: Date.now() - started,
      truncatedBySize: fitted.truncated,
    };
  });
}

/** Route /collection/indexes: danh sách index của collection. */
export async function indexesRoute(body: Body): Promise<IndexesResponse> {
  const record = await connectionFrom(body);
  const database = requireString(body, 'database', 255);
  const collection = requireString(body, 'collection', 255);
  const indexes = await withDatabase(record, database, (db) => db.collection(collection).indexes());
  return { indexes: indexes.map((index) => toRelaxed(index) as Record<string, unknown>) };
}
