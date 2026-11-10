/**
 * Hợp đồng giữa page (panel) và service. Mọi lời gọi đi qua host.serviceRequest,
 * body là JSON, và mọi phản hồi lỗi có dạng ErrorBody.
 *
 * Tài liệu BSON gửi về page dùng Extended JSON canonical (ví dụ { "$numberInt": "5" })
 * để sửa rồi lưu không làm đổi kiểu dữ liệu.
 */

/** Connection như page được phép thấy: không bao giờ có URI đầy đủ. */
export type ConnectionView = {
  id: string;
  name: string;
  /** Danh sách host đã bỏ user và password, ví dụ "db1:27017,db2:27017". */
  hosts: string;
  readOnly: boolean;
  connected: boolean;
};

/** Thân lỗi của mọi route; code ổn định để page chọn cách hiển thị. */
export type ErrorBody = {
  error: string;
  code: string;
  position?: { line: number; column: number };
  kind?: string;
};

export type ConnectionsListResponse = { connections: ConnectionView[] };
export type ConnectionResponse = { connection: ConnectionView };
export type OkResponse = { ok: true };

export type TestConnectionResponse =
  | { ok: true; version: string; elapsedMs: number }
  | { ok: false; error: string; code: string };

export type DatabaseInfo = {
  name: string;
  sizeOnDisk: number | null;
  empty: boolean;
};

export type CollectionInfo = {
  name: string;
  type: 'collection' | 'view';
  /** Số document ước tính; null với view hoặc khi đếm quá lâu. */
  count: number | null;
};

export type DatabasesResponse = { databases: DatabaseInfo[] };
export type CollectionsResponse = { collections: CollectionInfo[] };

export type FindResponse = {
  docs: unknown[];
  /** Tổng số document khớp filter; null nếu đếm bị quá thời gian. */
  total: number | null;
  elapsedMs: number;
  /** true nếu kết quả bị cắt vì vượt ngân sách kích thước phản hồi. */
  truncatedBySize: boolean;
};

export type IndexesResponse = { indexes: Array<Record<string, unknown>> };

export type InsertResponse = { insertedId: unknown };
export type ReplaceResponse = { matchedCount: number; modifiedCount: number };
export type DeleteResponse = { deletedCount: number };

export type QueryKind =
  | 'find'
  | 'findOne'
  | 'count'
  | 'distinct'
  | 'aggregate'
  | 'insertOne'
  | 'insertMany'
  | 'updateOne'
  | 'updateMany'
  | 'deleteOne'
  | 'deleteMany'
  | 'collectionNames'
  | 'stats';

export type QueryResponse = {
  kind: QueryKind;
  /** Kết quả đã serialize; kiểu tuỳ theo kind (mảng document, số, object...). */
  result: unknown;
  /** Số dòng khi kết quả là danh sách, ngược lại null. */
  count: number | null;
  /** true nếu danh sách bị cắt ở 500 dòng hoặc vì kích thước. */
  truncated: boolean;
  elapsedMs: number;
  /** Lệnh đã chạy, và tổng số lệnh trong editor. */
  statement: { start: number; end: number; index: number; total: number };
  isWrite: boolean;
};

export type HistoryEntry = {
  text: string;
  connectionId: string;
  database: string;
  at: number;
};

export type HistoryResponse = { entries: HistoryEntry[] };
