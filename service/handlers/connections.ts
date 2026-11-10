/**
 * Route quản lý connection. Page không bao giờ nhận được URI đầy đủ.
 */
import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';

import type {
  ConnectionResponse,
  ConnectionsListResponse,
  ConnectionView,
  OkResponse,
  TestConnectionResponse,
} from '../../shared/api.ts';
import { badRequest, HttpError, notFound, toHttpError } from '../errors.ts';
import { forgetConnection } from '../mentions-cache.ts';
import { warmConnection } from '../mentions.ts';
import { assertUsableUri, clientFor, closeConnection, isConnected } from '../pool.ts';
import { type ConnectionRecord, changeConnections, listConnections } from '../store.ts';
import { hostsOf } from '../uri.ts';
import { type Body, optionalBoolean, optionalString, requireString } from '../validate.ts';
import { requireRecord } from './common.ts';

const PROBE_OPTIONS = { appName: 'mongo-studio', serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 };

function viewOf(record: ConnectionRecord): ConnectionView {
  return {
    id: record.id,
    name: record.name,
    hosts: hostsOf(record.uri),
    readOnly: record.readOnly,
    connected: isConnected(record.id),
  };
}

/** Route /connections/list. */
export async function listRoute(): Promise<ConnectionsListResponse> {
  const records = await listConnections();
  return { connections: records.map(viewOf) };
}

function nameFrom(body: Body): string {
  const name = requireString(body, 'name', 64).trim();
  if (name === '') throw badRequest("Tên connection không được để trống");
  return name;
}

/** Route /connections/save: thêm mới (không có id) hoặc sửa (có id). URI để trống khi sửa = giữ nguyên. */
export async function saveRoute(body: Body): Promise<ConnectionResponse> {
  const id = optionalString(body, 'id', 64);
  const name = nameFrom(body);
  const readOnly = optionalBoolean(body, 'readOnly', false);
  const rawUri = optionalString(body, 'uri', 4096)?.trim() ?? '';
  if (!id && rawUri === '') throw badRequest('Cần nhập URI khi thêm connection mới');
  if (rawUri !== '') await assertUsableUri(rawUri);

  const record = await changeConnections((list) => {
    if (!id) {
      const created: ConnectionRecord = { id: randomUUID(), name, uri: rawUri, readOnly };
      return { list: [...list, created], result: created };
    }
    const index = list.findIndex((item) => item.id === id);
    const current = list[index];
    if (!current) throw notFound('Không tìm thấy connection này. Tải lại danh sách rồi thử lại.');
    const updated: ConnectionRecord = { ...current, name, readOnly, uri: rawUri || current.uri };
    const next = list.map((item, position) => (position === index ? updated : item));
    return { list: next, result: updated };
  });

  if (id && rawUri !== '') {
    await closeConnection(record.id);
  }
  if (id) forgetConnection(record.id);
  void warmConnection(record);
  return { connection: viewOf(record) };
}

/** Route /connections/delete. */
export async function deleteRoute(body: Body): Promise<OkResponse> {
  const id = requireString(body, 'id', 64);
  await changeConnections((list) => {
    if (!list.some((item) => item.id === id)) throw notFound('Connection này không còn tồn tại.');
    return { list: list.filter((item) => item.id !== id), result: undefined };
  });
  await closeConnection(id);
  forgetConnection(id);
  return { ok: true };
}

/** Route /connections/disconnect: đóng kết nối nhưng giữ cấu hình. */
export async function disconnectRoute(body: Body): Promise<OkResponse> {
  const id = requireString(body, 'id', 64);
  await requireRecord(id);
  await closeConnection(id);
  return { ok: true };
}

/** Kiểm tra một URI nháp bằng client tạm (không lưu); client luôn được đóng. */
async function probeDraft(uri: string): Promise<string> {
  await assertUsableUri(uri);
  const client = new MongoClient(uri.trim(), PROBE_OPTIONS);
  try {
    await client.connect();
    const info = await client.db('admin').command({ buildInfo: 1 });
    return String(info.version ?? 'unknown');
  } catch (error) {
    throw toHttpError(error, uri, 'connect');
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Ping connection đã lưu bằng client trong pool; lỗi kết nối được ghi nhận qua clientFor. */
async function probeStored(id: string | undefined): Promise<string> {
  if (!id) throw badRequest('Cần id connection hoặc URI để kiểm tra');
  const record = await requireRecord(id);
  const client = await clientFor(record);
  const info = await client.db('admin').command({ buildInfo: 1 });
  return String(info.version ?? 'unknown');
}

/** Route /connections/test: ping với URI nháp (chưa lưu) hoặc với connection đã lưu. */
export async function testRoute(body: Body): Promise<TestConnectionResponse> {
  const started = Date.now();
  const id = optionalString(body, 'id', 64);
  const draft = optionalString(body, 'uri', 4096)?.trim() ?? '';
  try {
    const version = draft !== '' ? await probeDraft(draft) : await probeStored(id);
    return { ok: true, version, elapsedMs: Date.now() - started };
  } catch (error) {
    const mapped = error instanceof HttpError ? error : toHttpError(error, null, 'connect');
    if (mapped.status === 500) throw mapped;
    return { ok: false, error: mapped.message, code: mapped.code };
  }
}
