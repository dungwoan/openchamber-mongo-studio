/**
 * Connection lấy từ file cấu hình của dự án. Chỉ nằm trong bộ nhớ của service:
 * không bao giờ ghi vào connections.json, không nhân bản mật khẩu, và URI không rời service.
 * Id xác định theo (thư mục dự án, tên file) nên mở lại dự án sẽ ra cùng một id.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ConnectionRecord } from './store.ts';
import { listConnections } from './store.ts';
import type { Detection } from './project-files.ts';

/** Connection phát hiện: một ConnectionRecord kèm file nguồn và thư mục dự án. */
export type DetectedRecord = ConnectionRecord & { sourceFile: string; projectKey: string };

const registry = new Map<string, DetectedRecord>();

/**
 * Id ổn định của connection phát hiện cho một dự án và một file.
 *
 * Args:
 *   projectKey: Đường dẫn đã chuẩn hoá của dự án.
 *   sourceFile: Tên file trong allowlist.
 *
 * Returns:
 *   Chuỗi 37 ký tự bắt đầu bằng "auto-".
 */
export function detectedId(projectKey: string, sourceFile: string): string {
  return `auto-${createHash('sha256').update(`${projectKey}\0${sourceFile}`).digest('hex').slice(0, 32)}`;
}

/**
 * Ghi connection phát hiện vào registry RAM (ghi đè nếu đã có). Không đụng connections.json.
 *
 * Args:
 *   projectKey: Đường dẫn đã chuẩn hoá của dự án.
 *   found: Kết quả tìm được trong file.
 *
 * Returns:
 *   Bản ghi connection đã đăng ký.
 */
export function registerDetected(projectKey: string, found: Extract<Detection, { kind: 'found' }>): DetectedRecord {
  const record: DetectedRecord = {
    id: detectedId(projectKey, found.sourceFile),
    name: `${path.basename(projectKey)} · ${found.sourceFile}`,
    uri: found.uri,
    // Luôn read-only: connection lấy từ file dự án không sửa được từ UI. Muốn ghi, thêm connection thủ công.
    readOnly: true,
    sourceFile: found.sourceFile,
    projectKey,
  };
  registry.set(record.id, record);
  return record;
}

/** Tìm connection theo id: ưu tiên connection đã lưu, sau đó là connection phát hiện trong RAM. */
export async function findConnection(id: string): Promise<ConnectionRecord | undefined> {
  const saved = (await listConnections()).find((item) => item.id === id);
  return saved ?? registry.get(id);
}
