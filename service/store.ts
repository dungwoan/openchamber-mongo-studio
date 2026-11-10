/**
 * Lưu connection và lịch sử query trong thư mục home của người dùng, không nằm trong package.
 * File được ghi tạm rồi đổi tên (atomic); thư mục 0700, file 0600.
 * Mọi thao tác ghi đi qua một hàng đợi để không ghi đè nhau khi có nhiều request cùng lúc.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { HistoryEntry } from '../shared/api.ts';
import { badRequest, HttpError } from './errors.ts';

/** Connection như lưu trên đĩa; URI chỉ tồn tại ở đây và trong bộ nhớ của service. */
export type ConnectionRecord = {
  id: string;
  name: string;
  uri: string;
  readOnly: boolean;
};

const HISTORY_LIMIT = 50;

/** Thư mục dữ liệu; đọc lúc chạy để HOME (kể cả khi test) được tôn trọng. */
export function dataDir(): string {
  return path.join(os.homedir(), '.openchamber-mongo-studio');
}

const connectionsFile = (): string => path.join(dataDir(), 'connections.json');
const historyFile = (): string => path.join(dataDir(), 'history.json');

let queue: Promise<unknown> = Promise.resolve();

/** Chạy tác vụ sau mọi tác vụ ghi trước đó. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(
      500,
      'STORE_CORRUPT',
      `File ${file} không đọc được (sai định dạng JSON). Sửa hoặc xoá file này rồi thử lại.`,
    );
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  await chmod(file, 0o600).catch(() => undefined);
}

function isRecord(value: unknown): value is ConnectionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.name === 'string'
    && typeof record.uri === 'string' && typeof record.readOnly === 'boolean';
}

/** Đọc toàn bộ connection đã lưu. */
export async function listConnections(): Promise<ConnectionRecord[]> {
  const data = await readJson(connectionsFile());
  const list = (data as { connections?: unknown } | null)?.connections;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

/**
 * Đọc rồi ghi lại danh sách connection trong một thao tác không bị xen ngang.
 *
 * Args:
 *   change: Nhận danh sách hiện tại, trả về danh sách mới và kết quả trả về cho caller.
 *
 * Returns:
 *   Kết quả do change trả về.
 */
export function changeConnections<T>(
  change: (list: ConnectionRecord[]) => { list: ConnectionRecord[]; result: T },
): Promise<T> {
  return exclusive(async () => {
    const { list, result } = change(await listConnections());
    await writeJson(connectionsFile(), { version: 1, connections: list });
    return result;
  });
}

/** Lịch sử query mới nhất trước, tối đa 50 mục. */
export async function listHistory(): Promise<HistoryEntry[]> {
  const data = await readJson(historyFile());
  const entries = (data as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is HistoryEntry => {
    const item = entry as Partial<HistoryEntry>;
    return typeof item.text === 'string' && typeof item.connectionId === 'string'
      && typeof item.database === 'string' && typeof item.at === 'number';
  });
}

/**
 * Thêm một mục vào lịch sử; trùng với mục mới nhất thì bỏ qua.
 *
 * Args:
 *   entry: Câu lệnh, connection, database và thời điểm chạy.
 */
export function addHistory(entry: HistoryEntry): Promise<void> {
  if (entry.text.trim() === '') throw badRequest('Không có nội dung để lưu vào lịch sử');
  return exclusive(async () => {
    const current = await listHistory();
    if (current[0]?.text === entry.text && current[0]?.connectionId === entry.connectionId) {
      current[0] = entry;
    } else {
      current.unshift(entry);
    }
    await writeJson(historyFile(), { version: 1, entries: current.slice(0, HISTORY_LIMIT) });
  });
}
