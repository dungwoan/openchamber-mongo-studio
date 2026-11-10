/**
 * Cache trong bộ nhớ các collection đã biết, dùng cho menu @ của composer.
 * Tìm kiếm chỉ đọc cache này, không gọi MongoDB, nên luôn trả lời trong 2 giây.
 */
import type { MentionsItem, MentionsSearchResult } from '@openchamber/sdk';

import type { CollectionInfo } from '../shared/api.ts';

const SEPARATOR = '\u001f';
const MAX_ITEMS = 20;
const MAX_TITLE = 120;
const MAX_ID = 256;

/** Tham chiếu tới một collection trong một connection. */
export type CollectionRef = {
  connectionId: string;
  database: string;
  collection: string;
};

type CacheEntry = CollectionRef & {
  connectionName: string;
  type: 'collection' | 'view';
  count: number | null;
};

const cache = new Map<string, CacheEntry>();

function keyOf(ref: CollectionRef): string {
  return [ref.connectionId, ref.database, ref.collection].join(SEPARATOR);
}

/**
 * Mã hoá tham chiếu thành id của row @; trả về null nếu id vượt giới hạn của SDK.
 *
 * Args:
 *   ref: Tham chiếu collection.
 */
export function encodeMentionId(ref: CollectionRef): string | null {
  const id = keyOf(ref);
  return id.length <= MAX_ID ? id : null;
}

/**
 * Giải mã id của row @.
 *
 * Args:
 *   id: Id mà SDK gửi lại khi người dùng chọn row.
 *
 * Returns:
 *   Tham chiếu, hoặc null nếu id không đúng dạng.
 */
export function decodeMentionId(id: string): CollectionRef | null {
  const parts = id.split(SEPARATOR);
  if (parts.length !== 3 || parts.some((part) => part === '')) return null;
  const [connectionId, database, collection] = parts as [string, string, string];
  return { connectionId, database, collection };
}

/**
 * Thay danh sách collection của một database trong cache.
 *
 * Args:
 *   connectionId: Id connection.
 *   connectionName: Tên connection hiển thị trên row.
 *   database: Tên database.
 *   collections: Danh sách collection mới.
 */
export function rememberCollections(
  connectionId: string,
  connectionName: string,
  database: string,
  collections: CollectionInfo[],
): void {
  for (const [key, entry] of cache) {
    if (entry.connectionId === connectionId && entry.database === database) cache.delete(key);
  }
  for (const info of collections) {
    const ref = { connectionId, database, collection: info.name };
    cache.set(keyOf(ref), { ...ref, connectionName, type: info.type, count: info.count });
  }
}

/** Xoá mọi collection của một connection (khi connection bị xoá hoặc đổi). */
export function forgetConnection(connectionId: string): void {
  for (const [key, entry] of cache) {
    if (entry.connectionId === connectionId) cache.delete(key);
  }
}

function titleOf(entry: CacheEntry): string {
  const full = `${entry.connectionName}/${entry.database}.${entry.collection}`;
  return full.length > MAX_TITLE ? `${full.slice(0, MAX_TITLE - 3)}...` : full;
}

function subtitleOf(entry: CacheEntry): string {
  if (entry.type === 'view') return 'view';
  if (entry.count === null) return 'collection';
  return `about ${entry.count.toLocaleString('en-US')} documents`;
}

/**
 * Tìm collection có tên chứa chuỗi query (không phân biệt hoa thường), tối đa 20 row.
 *
 * Args:
 *   query: Chuỗi người dùng gõ sau @; rỗng thì lấy 20 row đầu.
 *
 * Returns:
 *   Kết quả theo đúng hợp đồng MentionsSearchResult.
 */
export function searchMentions(query: string): MentionsSearchResult {
  const needle = query.trim().toLowerCase();
  const items: MentionsItem[] = [];
  const entries = [...cache.values()].sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
  for (const entry of entries) {
    if (items.length >= MAX_ITEMS) break;
    const title = titleOf(entry);
    if (needle !== '' && !title.toLowerCase().includes(needle)) continue;
    const id = encodeMentionId(entry);
    if (id === null) continue;
    items.push({ id, title, subtitle: subtitleOf(entry) });
  }
  return { items };
}
