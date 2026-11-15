/**
 * Bản nhớ theo dự án (projects.json): connection người dùng đã chọn, và cờ đã ngắt tự động.
 * Mọi hàm ở đây là thuần, không đụng đĩa, để kiểm thử được.
 */

/** Bản nhớ của một thư mục dự án. Không có trường nào thì coi như chưa nhớ gì. */
export type ProjectMemory = {
  /** id của connection đã lưu mà người dùng đã chọn cho dự án này. */
  connectionId?: string;
  /** true khi người dùng đã bấm Ngắt: lần mở sau không tự nối. */
  autoDisabled?: boolean;
  /** true khi từng phát hiện cấu hình trong file của dự án. */
  detected?: boolean;
};

/** Toàn bộ projects.json: khoá là đường dẫn tuyệt đối của dự án. */
export type ProjectsMap = Record<string, ProjectMemory>;

/** Nguồn kết nối sẽ dùng khi mở panel: không làm gì, nối connection đã nhớ, hoặc quét file. */
export type SourcePlan = 'disabled' | 'remembered' | 'scan';

const MAX_ID = 64;

/**
 * Làm sạch một mục đọc từ đĩa; bỏ mọi trường sai kiểu để không tin dữ liệu hỏng.
 *
 * Args:
 *   value: Giá trị JSON tuỳ ý.
 *
 * Returns:
 *   Bản nhớ hợp lệ, hoặc null nếu không phải đối tượng.
 */
export function sanitizeMemory(value: unknown): ProjectMemory | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const memory: ProjectMemory = {};
  if (typeof raw.connectionId === 'string' && raw.connectionId !== '' && raw.connectionId.length <= MAX_ID) {
    memory.connectionId = raw.connectionId;
  }
  if (raw.autoDisabled === true) memory.autoDisabled = true;
  if (raw.detected === true) memory.detected = true;
  return memory;
}

/**
 * Quyết định có nối connection đã nhớ hay phải quét file cấu hình.
 * Thứ tự ưu tiên: đã ngắt tự động > connection đã nhớ (còn tồn tại) > quét file.
 *
 * Args:
 *   memory: Bản nhớ của dự án.
 *   rememberedExists: connection đã nhớ còn tồn tại trong connections.json hay không.
 *
 * Returns:
 *   'disabled' nếu không được tự nối; 'remembered' nếu nối connection đã nhớ; 'scan' nếu cần quét file.
 */
export function pickSource(memory: ProjectMemory, rememberedExists: boolean): SourcePlan {
  if (memory.autoDisabled) return 'disabled';
  if (memory.connectionId !== undefined && rememberedExists) return 'remembered';
  return 'scan';
}

/** Bản nhớ sau khi bật hoặc tắt cờ đã ngắt tự động; giữ nguyên connectionId. */
export function withAutoDisabled(memory: ProjectMemory, disabled: boolean): ProjectMemory {
  const next: ProjectMemory = { ...memory };
  if (disabled) next.autoDisabled = true;
  else delete next.autoDisabled;
  return next;
}

/** Lựa chọn của người dùng trong cây: một connection đã lưu, hoặc connection lấy từ file của dự án. */
export type Selection = { kind: 'saved'; id: string } | { kind: 'detected' };

/**
 * Bản nhớ sau khi người dùng chọn một connection: chọn lại thì xoá cờ đã ngắt tự động.
 *
 * Args:
 *   memory: Bản nhớ hiện tại.
 *   selection: Connection vừa được chọn.
 *
 * Returns:
 *   Bản nhớ mới. Chọn connection đã lưu thì ghi connectionId; chọn cấu hình của dự án thì xoá connectionId.
 */
export function withSelection(memory: ProjectMemory, selection: Selection): ProjectMemory {
  const next: ProjectMemory = { ...memory };
  delete next.autoDisabled;
  if (selection.kind === 'saved') {
    next.connectionId = selection.id;
  } else {
    delete next.connectionId;
    next.detected = true;
  }
  return next;
}

/** Đánh dấu dự án đã từng phát hiện cấu hình trong file. */
export function withDetected(memory: ProjectMemory): ProjectMemory {
  return { ...memory, detected: true };
}
