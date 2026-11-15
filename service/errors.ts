/**
 * Đổi lỗi của driver và lỗi cú pháp thành HTTP status và thông báo tiếng Việt.
 *
 * Quy ước status: 400 dữ liệu gửi lên sai, 403 connection chỉ đọc, 404 không tìm thấy,
 * 409 cần xác nhận, 422 MongoDB từ chối thao tác, 424 không kết nối được tới MongoDB,
 * 500 lỗi nội bộ (luôn có JSON, không trả trang lỗi trơn).
 */
import type { ErrorBody } from '../shared/api.ts';
import { QuerySyntaxError } from '../shared/query-parser.ts';
import { hostsOf, redact } from './uri.ts';

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
  'Could not reach MongoDB after 5 seconds. Check the host, port and firewall, and that MongoDB is running, then try again.';
const NETWORK =
  'Lost the network connection to MongoDB. Check the network or VPN, then try again. The connection will be reopened next time.';
const AUTH_FAILED =
  'Wrong username or password, or wrong authSource. Check the URI (the user:password@ part and ?authSource=).';
const INVALID_URI = 'Invalid URI. Correct form: mongodb://user:pass@host:27017/?authSource=admin or mongodb+srv://...';

type DriverError = { name?: string; code?: number | string; codeName?: string; message?: string };

const DNS_CODES = new Set(['EAI_AGAIN', 'ENOTFOUND']);

/** Lỗi phân giải tên (DNS) nằm trong chuỗi cause của lỗi driver, ví dụ host "mongo" của Docker không có trên máy này. */
function dnsFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && DNS_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Thông báo khi host không phân giải được; chỉ nêu tên host (đã bỏ user, password và port), không có URI. */
function unresolvableHost(uri: string | null): HttpError {
  const first = hostsOf(uri ?? '').split(',')[0] ?? '';
  const host = first.replace(/:\d+$/, '');
  return new HttpError(
    424,
    'UNRESOLVABLE_HOST',
    `Could not resolve host "${host}" from this machine (it may be an internal Docker service name). Use a connection on a public port if you have one, or add a connection manually with a URI that works here.`,
  );
}

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
    return new HttpError(422, 'TIMEOUT', 'The query exceeded 30 seconds. Narrow the filter, add an index or lower the limit, then try again.');
  }
  if (error.code === 11000 || error.codeName === 'DuplicateKey') {
    return new HttpError(422, 'DUPLICATE_KEY', `Duplicate key (unique index): ${redact(error.message ?? '', uri)}`);
  }
  if (error.code === 13 || error.codeName === 'Unauthorized') {
    return new HttpError(422, 'UNAUTHORIZED', 'The account does not have permission for this operation. Check the user\'s roles in MongoDB.');
  }
  return new HttpError(422, 'MONGO_ERROR', redact(error.message ?? 'Unknown MongoDB error', uri));
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
    if (context === 'connect' && dnsFailure(error)) return unresolvableHost(uri);
    return connectionProblem(driverError, context) ?? operationProblem(driverError, uri);
  }
  return new HttpError(500, 'INTERNAL', 'Internal Mongo Studio error. See the OpenChamber log for details.');
}
