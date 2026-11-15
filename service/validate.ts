/**
 * Kiểm tra đầu vào JSON của route. Lỗi trả về là HTTP 400 với thông báo tiếng Việt.
 */
import { badRequest } from './errors.ts';

export type Body = Record<string, unknown>;

/** Chuỗi bắt buộc, không rỗng sau khi cắt khoảng trắng và không vượt max ký tự. */
export function requireString(body: Body, key: string, max = 512): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`Missing field '${key}'`);
  if (value.length > max) throw badRequest(`Field '${key}' is too long (at most ${max} characters)`);
  return value;
}

/** Chuỗi tuỳ chọn; trả về undefined nếu không có. */
export function optionalString(body: Body, key: string, max = 100_000): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`Field '${key}' must be a string`);
  if (value.length > max) throw badRequest(`Field '${key}' is too long (at most ${max} characters)`);
  return value;
}

/** Giá trị bool tuỳ chọn; mặc định là fallback. */
export function optionalBoolean(body: Body, key: string, fallback: boolean): boolean {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw badRequest(`Field '${key}' must be true or false`);
  return value;
}

/** Số nguyên tuỳ chọn trong khoảng [min, max]; trả về undefined nếu không có. */
export function optionalInteger(body: Body, key: string, min: number, max: number): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw badRequest(`Field '${key}' must be an integer`);
  if (value < min || value > max) throw badRequest(`Field '${key}' must be between ${min} and ${max}`);
  return value;
}

/** Đối tượng JSON bắt buộc (không phải mảng). */
export function requireObject(value: unknown, key: string): Body {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`Field '${key}' must be a JSON object`);
  }
  return value as Body;
}
