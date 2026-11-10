/**
 * Giữ MongoClient theo connection id. Kết nối mở lười ở lần dùng đầu tiên và đóng khi
 * connection bị xoá, ngắt kết nối, hoặc khi gặp lỗi mạng.
 */
import { type Db, MongoClient } from 'mongodb';

import { HttpError, toHttpError } from './errors.ts';
import type { ConnectionRecord } from './store.ts';
import { uriProblem } from './uri.ts';

const CLIENT_OPTIONS = {
  appName: 'mongo-studio',
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 120000,
  maxPoolSize: 5,
  // Giữ kiểu BSON khi đọc (Long, Int32, Double): nếu không, driver đổi chúng thành số JS
  // và lần lưu sau sẽ ghi sai kiểu dữ liệu.
  promoteValues: false,
  promoteLongs: false,
};

type PoolEntry = {
  uri: string;
  client: MongoClient;
  ready: Promise<MongoClient>;
  connected: boolean;
};

const pool = new Map<string, PoolEntry>();

/** Connection có đang mở và đã ping được hay không. */
export function isConnected(connectionId: string): boolean {
  return pool.get(connectionId)?.connected === true;
}

/**
 * Kiểm tra URI bằng cách dựng MongoClient (không kết nối). Ném HttpError nếu sai.
 *
 * Args:
 *   uri: Chuỗi kết nối cần kiểm tra.
 */
export async function assertUsableUri(uri: string): Promise<void> {
  const problem = uriProblem(uri);
  if (problem) throw invalidUri(problem);
  try {
    const client = new MongoClient(uri.trim(), CLIENT_OPTIONS);
    await client.close();
  } catch (error) {
    throw toHttpError(error, uri, 'connect');
  }
}

/** Lỗi URI có thông báo cụ thể, không chứa URI. */
function invalidUri(message: string): HttpError {
  return new HttpError(400, 'INVALID_URI', message);
}

/** Mở kết nối và ping để chắc server thật sự trả lời. */
async function connectAndPing(client: MongoClient, uri: string): Promise<MongoClient> {
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw toHttpError(error, uri, 'connect');
  }
}

/**
 * Trả về client đã sẵn sàng cho connection; dùng lại nếu URI không đổi.
 *
 * Args:
 *   record: Connection cần dùng.
 *
 * Returns:
 *   MongoClient đã ping thành công.
 *
 * Raises:
 *   HttpError: Không kết nối được (424), sai URI (400), hoặc lỗi khác.
 */
export async function clientFor(record: ConnectionRecord): Promise<MongoClient> {
  const existing = pool.get(record.id);
  if (existing && existing.uri === record.uri) return existing.ready;
  if (existing) await closeConnection(record.id);

  const problem = uriProblem(record.uri);
  if (problem) throw invalidUri(problem);

  let client: MongoClient;
  try {
    client = new MongoClient(record.uri, CLIENT_OPTIONS);
  } catch (error) {
    throw toHttpError(error, record.uri, 'connect');
  }
  const entry: PoolEntry = {
    uri: record.uri,
    client,
    connected: false,
    ready: connectAndPing(client, record.uri),
  };
  pool.set(record.id, entry);
  try {
    await entry.ready;
    entry.connected = true;
    return client;
  } catch (error) {
    if (pool.get(record.id) === entry) pool.delete(record.id);
    throw error;
  }
}

/**
 * Lấy database trên connection; nếu gặp lỗi mạng thì đóng client để lần sau kết nối lại.
 *
 * Args:
 *   record: Connection cần dùng.
 *   database: Tên database.
 *   task: Việc cần làm với database đó.
 *
 * Returns:
 *   Kết quả của task.
 */
export async function withDatabase<T>(
  record: ConnectionRecord,
  database: string,
  task: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await clientFor(record);
  try {
    return await task(client.db(database));
  } catch (error) {
    const mapped = toHttpError(error, record.uri);
    if (mapped.dropConnection) await closeConnection(record.id);
    throw mapped;
  }
}

/** Đóng client của connection (nếu có); không ném lỗi. */
export async function closeConnection(connectionId: string): Promise<void> {
  const entry = pool.get(connectionId);
  if (!entry) return;
  pool.delete(connectionId);
  await entry.client.close().catch(() => undefined);
}

/** Đóng mọi client khi service dừng. */
export async function closeAll(): Promise<void> {
  await Promise.all([...pool.keys()].map((id) => closeConnection(id)));
}
