/**
 * State dùng chung của panel: connection, database và collection đã tải, và các nút đang mở.
 * Không polling: dữ liệu chỉ tải khi người dùng mở hoặc làm mới.
 */
import type {
  CollectionInfo,
  CollectionsResponse,
  ConnectionsListResponse,
  ConnectionView,
  DatabaseInfo,
  DatabasesResponse,
} from '../shared/api.ts';
import type { Api } from './api.ts';

export type Listener = () => void;

export type TreeState = {
  connections: ConnectionView[];
  /** Có đang tải danh sách connection không. */
  loadingConnections: boolean;
  /** Lỗi tải danh sách connection (ví dụ service chưa bật). */
  connectionsError: string | null;
  databases: Map<string, DatabaseInfo[]>;
  collections: Map<string, CollectionInfo[]>;
  /** Lỗi tải database/collection theo connection hoặc theo "conn/db". */
  errors: Map<string, string>;
  loading: Set<string>;
  expandedConnections: Set<string>;
  expandedDatabases: Set<string>;
};

export const tree: TreeState = {
  connections: [],
  loadingConnections: false,
  connectionsError: null,
  databases: new Map(),
  collections: new Map(),
  errors: new Map(),
  loading: new Set(),
  expandedConnections: new Set(),
  expandedDatabases: new Set(),
};

const listeners = new Set<Listener>();

/** Đăng ký hàm được gọi mỗi khi cây thay đổi; trả về hàm huỷ đăng ký. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Khoá cho một database trong cây: "connectionId/database". */
export function dbKey(connectionId: string, database: string): string {
  return `${connectionId}/${database}`;
}

/** Tải lại danh sách connection và giữ lại cache của những connection còn tồn tại. */
export async function loadConnections(api: Api): Promise<void> {
  tree.loadingConnections = true;
  emit();
  try {
    const reply = await api.call<ConnectionsListResponse>('/connections/list');
    tree.connections = reply.connections;
    tree.connectionsError = null;
    const alive = new Set(reply.connections.map((item) => item.id));
    for (const id of [...tree.expandedConnections]) if (!alive.has(id)) tree.expandedConnections.delete(id);
  } catch (error) {
    tree.connectionsError = error instanceof Error ? error.message : 'Không tải được danh sách connection';
  } finally {
    tree.loadingConnections = false;
    emit();
  }
}

/** Xoá cache database và collection của một connection (sau khi sửa, ngắt hoặc xoá). */
export function forgetConnectionCache(connectionId: string): void {
  tree.databases.delete(connectionId);
  tree.errors.delete(connectionId);
  for (const key of [...tree.collections.keys()]) if (key.startsWith(`${connectionId}/`)) tree.collections.delete(key);
  for (const key of [...tree.errors.keys()]) if (key.startsWith(`${connectionId}/`)) tree.errors.delete(key);
  for (const key of [...tree.expandedDatabases]) if (key.startsWith(`${connectionId}/`)) tree.expandedDatabases.delete(key);
}

/** Tải danh sách database của một connection. */
export async function loadDatabases(api: Api, connectionId: string): Promise<DatabaseInfo[]> {
  tree.loading.add(connectionId);
  tree.errors.delete(connectionId);
  emit();
  try {
    const reply = await api.call<DatabasesResponse>('/tree/databases', { connectionId });
    tree.databases.set(connectionId, reply.databases);
    return reply.databases;
  } catch (error) {
    tree.errors.set(connectionId, errorText(error));
    throw error;
  } finally {
    tree.loading.delete(connectionId);
    emit();
  }
}

/** Tải collection của một database; cache được dùng lại khi đã có. */
export async function loadCollections(api: Api, connectionId: string, database: string): Promise<CollectionInfo[]> {
  const key = dbKey(connectionId, database);
  tree.loading.add(key);
  tree.errors.delete(key);
  emit();
  try {
    const reply = await api.call<CollectionsResponse>('/tree/collections', { connectionId, database });
    tree.collections.set(key, reply.collections);
    return reply.collections;
  } catch (error) {
    tree.errors.set(key, errorText(error));
    throw error;
  } finally {
    tree.loading.delete(key);
    emit();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Lỗi không xác định';
}

/** Tên connection theo id, hoặc null nếu connection đã bị xoá. */
export function connectionName(connectionId: string): string | null {
  return tree.connections.find((item) => item.id === connectionId)?.name ?? null;
}
