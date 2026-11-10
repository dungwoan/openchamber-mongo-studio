/**
 * Helper dùng chung cho các handler: tìm connection, đọc literal, chặn ghi và giới hạn song song.
 */
import { badRequest, HttpError, notFound } from '../errors.ts';
import { parseLiteral, QuerySyntaxError, type Obj } from '../../shared/query-parser.ts';
import { listConnections, type ConnectionRecord } from '../store.ts';
import { type Body, requireString } from '../validate.ts';

/** Ngân sách ký tự cho danh sách document gửi về page (phản hồi tối đa 8 MB). */
export const RESPONSE_BUDGET = 6_000_000;

/** Tìm connection theo id; ném 404 nếu đã bị xoá. */
export async function requireRecord(id: string): Promise<ConnectionRecord> {
  const record = (await listConnections()).find((item) => item.id === id);
  if (!record) throw notFound('Không tìm thấy connection này. Tải lại danh sách rồi thử lại.');
  return record;
}

/** Lấy connection từ body.connectionId. */
export async function connectionFrom(body: Body): Promise<ConnectionRecord> {
  return requireRecord(requireString(body, 'connectionId', 64));
}

/** Chặn thao tác ghi khi connection đang ở chế độ chỉ đọc. */
export function assertWritable(record: ConnectionRecord): void {
  if (!record.readOnly) return;
  throw new HttpError(
    403,
    'READ_ONLY',
    `Connection "${record.name}" đang bật chế độ chỉ đọc (Read-only), không thể thêm, sửa hoặc xoá. Sửa connection và bỏ chọn Read-only nếu cần ghi.`,
  );
}

/**
 * Đọc một chuỗi literal (filter, sort, document...) và báo lỗi kèm tên trường.
 *
 * Args:
 *   text: Nội dung người dùng nhập.
 *   label: Tên trường hiển thị trong thông báo lỗi.
 *
 * Returns:
 *   Giá trị Extended JSON.
 *
 * Raises:
 *   HttpError 400 kèm vị trí dòng và cột khi cú pháp sai.
 */
export function literalField(text: string, label: string): unknown {
  try {
    return parseLiteral(text);
  } catch (error) {
    if (error instanceof QuerySyntaxError) {
      throw new HttpError(400, 'SYNTAX', `${label}: ${error.message}`, {
        position: { line: error.line, column: error.column },
      });
    }
    throw error;
  }
}

/** Literal là đối tượng JSON; chuỗi rỗng hoặc không nhập thì trả về undefined. */
export function optionalObjectLiteral(text: string | undefined, label: string): Obj | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const value = literalField(text, label);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`${label} phải là một đối tượng {...}`);
  }
  return value as Obj;
}

/**
 * Chạy hàm cho từng phần tử với tối đa `limit` tác vụ cùng lúc.
 *
 * Args:
 *   items: Danh sách đầu vào.
 *   limit: Số tác vụ song song tối đa.
 *   task: Hàm xử lý một phần tử.
 *
 * Returns:
 *   Kết quả theo đúng thứ tự đầu vào.
 */
export async function mapWithLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
