/**
 * Đổi giữa Extended JSON (dạng page gửi và nhận) và kiểu BSON của driver.
 * Driver 7 chỉ export EJSON qua namespace BSON.
 */
import { BSON } from 'mongodb';

const { EJSON } = BSON;

/**
 * Đổi giá trị Extended JSON thành kiểu BSON để ghi hoặc truy vấn.
 * Hỗ trợ đầy đủ $oid, $date, $numberLong/Int/Decimal, $uuid, $regularExpression.
 *
 * Args:
 *   value: Giá trị dạng JSON (ví dụ { "$oid": "..." }).
 *
 * Returns:
 *   Giá trị dùng được với driver (ObjectId, Date, Long...).
 */
export function toBson(value: unknown): unknown {
  return EJSON.deserialize(value as Record<string, unknown>, { relaxed: true });
}

function isBsonValue(value: object): boolean {
  return typeof (value as { _bsontype?: unknown })._bsontype === 'string' || value instanceof Date;
}

/**
 * Đổi giá trị sang JSON để gửi về page. Giá trị BSON (ObjectId, Date, Int32, Double, Long,
 * Decimal128...) được viết dạng Extended JSON canonical để giữ đúng kiểu khi sửa rồi lưu lại.
 * Số, chuỗi và boolean thuần (ví dụ kết quả count) giữ nguyên.
 *
 * Args:
 *   value: Giá trị từ driver hoặc kết quả truy vấn.
 *
 * Returns:
 *   Giá trị JSON-serializable.
 */
export function toJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (isBsonValue(value)) return EJSON.serialize(value as Record<string, unknown>, { relaxed: false });
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(out, key, { value: toJson(child), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * Đổi giá trị sang JSON dễ đọc (relaxed): dùng cho nội dung chỉ hiển thị như index key.
 *
 * Args:
 *   value: Giá trị từ driver.
 *
 * Returns:
 *   Giá trị JSON-serializable, số hiển thị dạng số thường.
 */
export function toRelaxed(value: unknown): unknown {
  return EJSON.serialize(value as Record<string, unknown>, { relaxed: true });
}

/**
 * Đọc số từ giá trị có thể là số JS hoặc kiểu BSON số (Int32, Double, Long).
 *
 * Args:
 *   value: Giá trị cần đọc.
 *
 * Returns:
 *   Số, hoặc null nếu không đọc được.
 */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null) {
    const wrapped = value as { toNumber?: () => number; valueOf?: () => unknown };
    if (typeof wrapped.toNumber === 'function') return wrapped.toNumber();
    if (typeof wrapped.valueOf === 'function' && typeof wrapped.valueOf() === 'number') return wrapped.valueOf() as number;
  }
  return null;
}

/**
 * Giữ các phần tử đầu tiên mà tổng kích thước JSON không vượt ngân sách.
 *
 * Args:
 *   items: Danh sách đã serialize sang JSON.
 *   budget: Số ký tự tối đa cho toàn bộ danh sách.
 *
 * Returns:
 *   Danh sách đã cắt và cờ cho biết có bị cắt không.
 */
export function fitToBudget(items: unknown[], budget: number): { items: unknown[]; truncated: boolean } {
  const kept: unknown[] = [];
  let used = 2;
  for (const item of items) {
    const size = JSON.stringify(item).length + 1;
    if (used + size > budget) return { items: kept, truncated: true };
    used += size;
    kept.push(item);
  }
  return { items: kept, truncated: false };
}
