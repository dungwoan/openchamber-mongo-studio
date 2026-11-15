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
  /** "project-file" với connection lấy từ file cấu hình của dự án (không lưu, không sửa, không xoá được). */
  source?: 'saved' | 'project-file';
  /** Tên file cấu hình nguồn, ví dụ ".env", chỉ có khi source là "project-file". */
  sourceFile?: string;
};

/** Connection mà panel nhận khi tự kết nối theo dự án. Không có URI, không có mật khẩu. */
export type ProjectConnectionView = {
  id: string;
  name: string;
  /** Danh sách host kèm port, không có thông tin đăng nhập, ví dụ "db1:27017". */
  host: string;
  /** Tên database trong URI, hoặc chuỗi rỗng. */
  db: string;
  source: 'remembered' | 'project-file';
  sourceFile?: string;
};

/** Kết quả của /project/open: không làm gì, đã nối, hoặc không nối được (kèm lý do an toàn để hiển thị). */
export type ProjectConnectResponse =
  | { status: 'none' }
  | { status: 'connected'; connection: ProjectConnectionView }
  | {
      status: 'error';
      source: 'remembered' | 'project-file';
      name?: string;
      sourceFile?: string;
      code: string;
      error: string;
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
