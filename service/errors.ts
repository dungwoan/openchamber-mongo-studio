/**
 * Đổi lỗi của driver và lỗi cú pháp thành HTTP status và thông báo tiếng Việt.
 *
 * Quy ước status: 400 dữ liệu gửi lên sai, 403 connection chỉ đọc, 404 không tìm thấy,
 * 409 cần xác nhận, 422 MongoDB từ chối thao tác, 424 không kết nối được tới MongoDB,
 * 500 lỗi nội bộ (luôn có JSON, không trả trang lỗi trơn).
 */
import type { ErrorBody } from '../shared/api.ts';
import { QuerySyntaxError } from '../shared/query-parser.ts';
import { redact } from './uri.ts';

/** Lỗi có HTTP status; message luôn an toàn để trả về page. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly position?: { line: number; column: number };
  /** true khi kết nối tới MongoDB đã hỏng và nên đóng client để kết nối lại. */
  readonly dropConnection: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { position?: { line: number; column: number }; dropConnection?: boolean } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.position = options.position;
    this.dropConnection = options.dropConnection ?? false;
  }

  /** Thân JSON trả về cho page. */
  toBody(): ErrorBody {
    const body: ErrorBody = { error: this.message, code: this.code };
    if (this.position) body.position = this.position;
    return body;
  }
}

/** Lỗi mà người dùng gây ra khi nhập liệu hoặc gọi route sai. */
export function badRequest(message: string): HttpError {
  return new HttpError(400, 'BAD_REQUEST', message);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, 'NOT_FOUND', message);
}

const UNREACHABLE =
  'Không kết nối được tới MongoDB sau 5 giây. Kiểm tra host, port, tường lửa (firewall) và MongoDB có đang chạy không, rồi thử lại.';
const NETWORK =
  'Mất kết nối mạng tới MongoDB. Kiểm tra mạng hoặc VPN, rồi thử lại. Kết nối sẽ được mở lại ở lần sau.';
const AUTH_FAILED =
  'Sai tên đăng nhập hoặc mật khẩu, hoặc authSource không đúng. Kiểm tra lại URI (phần user:password@ và ?authSource=).';
const INVALID_URI = 'URI không hợp lệ. Dạng đúng: mongodb://user:pass@host:27017/?authSource=admin hoặc mongodb+srv://...';

type DriverError = { name?: string; code?: number | string; codeName?: string; message?: string };

/** Lỗi của driver luôn có tên bắt đầu bằng "Mongo"; lỗi JS khác không thuộc nhánh này. */
function driverErrorOf(error: unknown): DriverError | null {
  if (typeof error !== 'object' || error === null) return null;
  const name = (error as DriverError).name ?? '';
  return name.startsWith('Mongo') ? (error as DriverError) : null;
}

/** Phân loại lỗi kết nối của driver; trả về null nếu không phải lỗi kết nối. */
function connectionProblem(error: DriverError, context: 'connect' | 'query'): HttpError | null {
  const name = error.name ?? '';
  if (name === 'MongoServerSelectionError') return new HttpError(424, 'UNREACHABLE', UNREACHABLE, { dropConnection: true });
  if (name === 'MongoNetworkError' || name === 'MongoNetworkTimeoutError') {
    return new HttpError(424, 'NETWORK', NETWORK, { dropConnection: true });
  }
  if (name === 'MongoParseError' && context === 'connect') return new HttpError(400, 'INVALID_URI', INVALID_URI);
  if (error.code === 18 || error.codeName === 'AuthenticationFailed') {
    return new HttpError(424, 'AUTH_FAILED', AUTH_FAILED, { dropConnection: true });
  }
  return null;
}

/** Phân loại lỗi thao tác do MongoDB trả về (sau khi đã kết nối được). */
function operationProblem(error: DriverError, uri: string | null): HttpError {
  if (error.code === 50 || error.codeName === 'MaxTimeMSExpired') {
    return new HttpError(422, 'TIMEOUT', 'Truy vấn vượt quá 30 giây. Thu hẹp filter, thêm index hoặc giảm limit rồi thử lại.');
  }
  if (error.code === 11000 || error.codeName === 'DuplicateKey') {
    return new HttpError(422, 'DUPLICATE_KEY', `Trùng khoá duy nhất (unique index): ${redact(error.message ?? '', uri)}`);
  }
  if (error.code === 13 || error.codeName === 'Unauthorized') {
    return new HttpError(422, 'UNAUTHORIZED', 'Tài khoản không đủ quyền cho thao tác này. Kiểm tra role của user trong MongoDB.');
  }
  return new HttpError(422, 'MONGO_ERROR', redact(error.message ?? 'Lỗi không xác định từ MongoDB', uri));
}

/**
 * Đổi mọi lỗi thành HttpError an toàn để trả về page.
 *
 * Args:
 *   error: Lỗi bắt được từ route, driver hoặc parser.
 *   uri: URI đang dùng, để che thông tin đăng nhập trong thông báo.
 *   context: 'connect' khi đang mở kết nối, 'query' khi chạy thao tác.
 *
 * Returns:
 *   HttpError có status và code phù hợp.
 */
export function toHttpError(error: unknown, uri: string | null = null, context: 'connect' | 'query' = 'query'): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof QuerySyntaxError) {
    return new HttpError(400, 'SYNTAX', error.message, { position: { line: error.line, column: error.column } });
  }
  const driverError = driverErrorOf(error);
  if (driverError) {
    return connectionProblem(driverError, context) ?? operationProblem(driverError, uri);
  }
  return new HttpError(500, 'INTERNAL', 'Lỗi nội bộ của Mongo Studio. Xem log của OpenChamber để biết thêm.');
}
