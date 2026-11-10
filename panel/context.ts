/**
 * Context dùng chung cho các view: API, thông báo, clipboard và cách mở tab.
 */
import type { ConnectionView } from '../shared/api.ts';
import type { Api, GuestHost } from './api.ts';

export type ToastKind = 'success' | 'error' | 'info';

export type Ctx = {
  host: GuestHost;
  api: Api;
  toast(kind: ToastKind, message: string): void;
  copy(text: string, what: string): void;
  openCollection(connectionId: string, database: string, collection: string): void;
  openQuery(seed?: { connectionId: string | null; database: string | null; text: string }): void;
  addConnection(): void;
  editConnection(connection: ConnectionView): void;
  disconnect(connection: ConnectionView): void;
  deleteConnection(connection: ConnectionView): void;
  closeTabsOf(connectionId: string): void;
};

/** Chuỗi lỗi an toàn để hiển thị, kể cả khi lỗi không phải Error. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Lỗi không xác định';
}
