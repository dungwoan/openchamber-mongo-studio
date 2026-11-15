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

/** Một field của collection. children dùng cho object lồng (tối đa 3 cấp). */
export type SchemaField = {
  name: string;
  type: string;
  required: boolean;
  pk: boolean;
  array: boolean;
  /** true khi chỉ suy đoán (ví dụ từ fillable, không có khai báo kiểu). */
  inferred: boolean;
  children: SchemaField[];
};

export type SchemaIndex = { name: string; keys: string[]; unique: boolean; ttl: boolean };

export type SchemaCollection = {
  name: string;
  model: string | null;
  /** Đường dẫn tương đối trong dự án, không có "..", không tuyệt đối. */
  file: string | null;
  orm: string;
  /** declared: có khai báo rõ trong code; inferred: suy ra từ quy ước (tên lớp, tên field). */
  confidence: 'declared' | 'inferred';
  origin: 'static' | 'agent';
  fields: SchemaField[];
  indexes: SchemaIndex[];
};

export type SchemaRelation = {
  from: string;
  to: string;
  field: string | null;
  kind: 'belongsTo' | 'hasMany' | 'hasOne' | 'belongsToMany' | 'reference';
  confidence: 'declared' | 'inferred';
};

/** Báo cáo sơ đồ v1: kết quả quét tĩnh, báo cáo của agent, hoặc bản gộp của hai. */
export type SchemaReport = {
  version: 1;
  generatedAt: string;
  source: { kind: 'static' | 'agent' | 'merged'; detectors: string[] };
  truncated: boolean;
  warnings: string[];
  collections: SchemaCollection[];
  relations: SchemaRelation[];
};

export type DiagramScanResponse = {
  report: SchemaReport;
  /** Đường dẫn tương đối file đã ghi trong dự án, hoặc null nếu không bật ghi. */
  written: string | null;
  /** missing: .gitignore có nhưng chưa có dòng ".openchamber/"; absent: không có .gitignore; present: đã có. */
  gitignore: 'missing' | 'present' | 'absent';
};

export type DiagramGetResponse = {
  report: SchemaReport;
  /** true khi dự án có file báo cáo của agent (đã được kiểm tra và gộp). */
  hasAgentReport: boolean;
};

export type DiagramAgentResponse = { report: SchemaReport | null; warnings: string[] };

/** Vị trí các thẻ sơ đồ theo tên collection (layout.json). */
export type DiagramLayoutGetResponse = { positions: Record<string, { x: number; y: number }> };
export type DiagramLayoutSaveResponse = { written: string };
