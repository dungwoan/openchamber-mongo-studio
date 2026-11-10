/**
 * Gọi service qua host.serviceRequest. Mọi lỗi (kể cả lỗi của chính OpenChamber) đều
 * đổi thành ApiError có thông báo tiếng Việt kèm hướng xử lý.
 */
import type { connectHost } from '@openchamber/sdk';

import type { ErrorBody } from '../shared/api.ts';

export type GuestHost = ReturnType<typeof connectHost>;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly position: { line: number; column: number } | null;

  constructor(message: string, code: string, status: number, position: { line: number; column: number } | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.position = position;
  }
}

export type Api = {
  call<T>(path: string, body?: Record<string, unknown>): Promise<T>;
};

/** Thông báo cho các mã lỗi do chính OpenChamber trả về. */
const HOST_MESSAGES: Record<string, string> = {
  NO_SERVICE: 'Service của Mongo Studio chưa được bật. Mở Settings → Extensions, bật Mongo Studio và cho phép service, rồi thử lại.',
  DISABLED: 'Mongo Studio đang tạm dừng trong Settings → Extensions. Bật lại để tiếp tục.',
  SERVICE_FAILED: 'Service của Mongo Studio không khởi động được. Xem log của OpenChamber, rồi thử lại.',
  REQUEST_FAILED: 'Service không trả lời (có thể đã quá thời gian). Thử lại sau vài giây.',
  RESPONSE_TOO_LARGE: 'Kết quả quá lớn để hiển thị. Thu hẹp filter hoặc giảm limit rồi thử lại.',
  HOST_TIMEOUT: 'OpenChamber không phản hồi kịp. Thử lại sau vài giây.',
};

function hostFailure(error: unknown): ApiError {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'HOST';
  const message = HOST_MESSAGES[code] ?? (error instanceof Error ? error.message : 'Không gọi được service');
  return new ApiError(message, code, 0);
}

function parseReply(text: string): unknown {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null && typeof (value as ErrorBody).error === 'string';
}

/**
 * Tạo client gọi service.
 *
 * Args:
 *   host: Client của OpenChamber đã kết nối.
 *
 * Returns:
 *   Hàm call(path, body) trả về JSON hoặc ném ApiError.
 */
export function createApi(host: GuestHost): Api {
  return {
    async call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
      let reply: { status: number; body: string };
      try {
        reply = await host.serviceRequest({ method: 'POST', path, body: JSON.stringify(body) });
      } catch (error) {
        throw hostFailure(error);
      }
      const data = parseReply(reply.body);
      if (data === null) {
        throw new ApiError('Service trả về dữ liệu không đọc được. Thử mở lại Mongo Studio.', 'BAD_RESPONSE', reply.status);
      }
      // Chỉ HTTP 4xx/5xx là lỗi. Kết quả thất bại có chủ đích (ví dụ test connection) trả 200 với ok:false.
      if (reply.status >= 400) {
        const failure = isErrorBody(data) ? data : { error: `Lỗi HTTP ${reply.status}`, code: 'HTTP' };
        throw new ApiError(failure.error, failure.code, reply.status, failure.position ?? null);
      }
      return data as T;
    },
  };
}
