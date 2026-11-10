/**
 * Xử lý chuỗi kết nối MongoDB: kiểm tra, che thông tin đăng nhập và làm sạch thông báo lỗi.
 * URI và mật khẩu không bao giờ được trả về page hay ghi vào log.
 */

const SCHEME = /^mongodb(\+srv)?:\/\//;
const MAX_URI_LENGTH = 4096;

/** Phần authority (user:pass@hosts) của URI, không gồm đường dẫn hay query. */
function authorityOf(uri: string): string {
  const afterScheme = uri.replace(SCHEME, '');
  const end = afterScheme.search(/[/?]/);
  return end === -1 ? afterScheme : afterScheme.slice(0, end);
}

/**
 * Trả về danh sách host, đã bỏ user và password.
 *
 * Args:
 *   uri: Chuỗi kết nối đầy đủ.
 *
 * Returns:
 *   Chuỗi host như "db1:27017,db2:27017", hoặc chuỗi rỗng nếu không đọc được.
 */
export function hostsOf(uri: string): string {
  const authority = authorityOf(uri);
  const at = authority.lastIndexOf('@');
  return at === -1 ? authority : authority.slice(at + 1);
}

/**
 * Kiểm tra định dạng cơ bản của URI trước khi lưu.
 *
 * Args:
 *   uri: Chuỗi kết nối người dùng nhập.
 *
 * Returns:
 *   Thông báo lỗi tiếng Việt, hoặc null nếu hợp lệ về mặt định dạng.
 */
export function uriProblem(uri: string): string | null {
  const trimmed = uri.trim();
  if (trimmed.length > MAX_URI_LENGTH) return 'URI quá dài';
  if (!SCHEME.test(trimmed)) return 'URI phải bắt đầu bằng mongodb:// hoặc mongodb+srv://';
  if (hostsOf(trimmed) === '') return 'URI thiếu địa chỉ host, ví dụ mongodb://localhost:27017';
  return null;
}

/** Các biến thể của user và password để che chúng trong thông báo lỗi. */
function secretsOf(uri: string | null): string[] {
  if (!uri) return [];
  const match = /^mongodb(?:\+srv)?:\/\/([^:@/]*)(?::([^@/]*))?@/.exec(uri);
  if (!match) return [];
  // Chuỗi quá ngắn (1-2 ký tự) sẽ che nhầm cả thông báo, nên bỏ qua.
  const values = [match[1] ?? '', match[2] ?? ''].filter((value) => value.length >= 3);
  const decoded = values.map((value) => safeDecode(value));
  return [...values, ...decoded, uri];
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Thay mọi user, password và chính URI có trong thông báo bằng ***.
 *
 * Args:
 *   message: Thông báo lỗi gốc từ driver.
 *   uri: URI đã dùng, hoặc null.
 *
 * Returns:
 *   Thông báo đã che, cắt tối đa 500 ký tự.
 */
export function redact(message: string, uri: string | null): string {
  let safe = message;
  for (const secret of secretsOf(uri)) {
    safe = safe.split(secret).join('***');
  }
  return safe.length > 500 ? `${safe.slice(0, 497)}...` : safe;
}
