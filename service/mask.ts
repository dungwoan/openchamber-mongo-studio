/**
 * Che giá trị của các field nhạy cảm (password, secret, token, key...) trước khi đưa
 * nội dung document vào văn bản gửi cho agent.
 */

const SENSITIVE_KEY = /pass|pwd|secret|token|key|credential/i;
const MASK = '***';

/**
 * Trả về bản sao của giá trị, mọi giá trị có tên field nhạy cảm được thay bằng ***.
 *
 * Args:
 *   value: Giá trị JSON (object, mảng hoặc nguyên thuỷ).
 *
 * Returns:
 *   Bản sao đã che; không sửa đối số gốc.
 */
export function maskSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: SENSITIVE_KEY.test(key) ? MASK : maskSensitive(child),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
