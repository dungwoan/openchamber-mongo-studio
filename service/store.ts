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
import { type ProjectsMap, sanitizeMemory } from './project-memory.ts';

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
const projectsFile = (): string => path.join(dataDir(), 'projects.json');

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
      `File ${file} could not be read (invalid JSON). Fix or delete this file, then try again.`,
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

/**
 * Đọc bản nhớ theo dự án. File hỏng chỉ làm mất bản nhớ (ghi log), không chặn cả panel.
 *
 * Returns:
 *   Map từ đường dẫn dự án sang bản nhớ đã làm sạch.
 */
export async function listProjects(): Promise<ProjectsMap> {
  let data: unknown;
  try {
    data = await readJson(projectsFile());
  } catch (error) {
    if (error instanceof HttpError && error.code === 'STORE_CORRUPT') {
      console.error('mongo-studio: projects.json is corrupt; project memory is ignored');
      return {};
    }
    throw error;
  }
  const projects = (data as { projects?: unknown } | null)?.projects;
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) return {};
  const result: ProjectsMap = {};
  for (const [key, value] of Object.entries(projects)) {
    const memory = sanitizeMemory(value);
    if (memory && key.startsWith('/')) result[key] = memory;
  }
  return result;
}

/**
 * Đọc rồi ghi lại bản nhớ theo dự án trong một thao tác không bị xen ngang. Không ghi nếu không đổi.
 *
 * Args:
 *   change: Nhận bản nhớ hiện tại, trả về bản nhớ mới và kết quả cho caller.
 *
 * Returns:
 *   Kết quả do change trả về.
 */
export function changeProjects<T>(change: (map: ProjectsMap) => { map: ProjectsMap; result: T }): Promise<T> {
  return exclusive(async () => {
    const before = await listProjects();
    const { map, result } = change(before);
    if (JSON.stringify(map) !== JSON.stringify(before)) {
      await writeJson(projectsFile(), { version: 1, projects: map });
    }
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
  if (entry.text.trim() === '') throw badRequest('Nothing to save to history');
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
