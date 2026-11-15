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
  NO_SERVICE: 'The Mongo Studio service is not enabled. Open Settings → Extensions, enable Mongo Studio and allow its service, then try again.',
  DISABLED: 'Mongo Studio is paused in Settings → Extensions. Turn it back on to continue.',
  SERVICE_FAILED: 'The Mongo Studio service could not start. Check the OpenChamber log, then try again.',
  REQUEST_FAILED: 'The service did not respond (it may have timed out). Try again in a few seconds.',
  RESPONSE_TOO_LARGE: 'The result is too large to display. Narrow the filter or lower the limit, then try again.',
  HOST_TIMEOUT: 'OpenChamber did not respond in time. Try again in a few seconds.',
};

function hostFailure(error: unknown): ApiError {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'HOST';
  const message = HOST_MESSAGES[code] ?? (error instanceof Error ? error.message : 'Could not call the service');
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
        throw new ApiError('The service returned unreadable data. Try reopening Mongo Studio.', 'BAD_RESPONSE', reply.status);
      }
      // Chỉ HTTP 4xx/5xx là lỗi. Kết quả thất bại có chủ đích (ví dụ test connection) trả 200 với ok:false.
      if (reply.status >= 400) {
        const failure = isErrorBody(data) ? data : { error: `HTTP error ${reply.status}`, code: 'HTTP' };
        throw new ApiError(failure.error, failure.code, reply.status, failure.position ?? null);
      }
      return data as T;
    },
  };
}
