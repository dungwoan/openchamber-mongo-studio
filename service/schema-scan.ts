/**
 * Quét các file mã nguồn của dự án để tìm định nghĩa model/collection. Chỉ đọc file; không import,
 * không chạy code, không đi qua symlink. Giới hạn: độ sâu, số file, kích thước file.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isScannedSubdir, MAX_FILE_BYTES, type ProjectDir } from './project-files.ts';

export type ScanFile = { rel: string; text: string };

export const MAX_SCAN_FILES = 2000;
export const MAX_SCAN_DEPTH = 6;
/** Đuôi file được đọc. .env, docker-compose và các file khác không nằm trong danh sách này. */
export const SCAN_EXTENSIONS = ['.ts', '.js', '.mjs', '.php', '.prisma', '.json'] as const;

export type ScanLimits = { maxFiles?: number; maxDepth?: number };

/**
 * Liệt kê và đọc các file mã nguồn được phép trong thư mục dự án (BFS, sắp theo đường dẫn).
 *
 * Args:
 *   dir: Thư mục dự án đã kiểm tra bằng resolveProjectDir.
 *   limits: Ghi đè giới hạn (chủ yếu để test).
 *
 * Returns:
 *   Danh sách file, có truncated nếu đã chạm trần số file, và cảnh báo.
 */
export async function collectFiles(
  dir: ProjectDir,
  limits: ScanLimits = {},
): Promise<{ files: ScanFile[]; truncated: boolean; warnings: string[] }> {
  const maxFiles = limits.maxFiles ?? MAX_SCAN_FILES;
  const maxDepth = limits.maxDepth ?? MAX_SCAN_DEPTH;
  const files: ScanFile[] = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  let truncated = false;
  let oversized = 0;

  while (queue.length > 0 && !truncated) {
    const current = queue.shift() as { rel: string; depth: number };
    const entries = await listEntries(path.join(dir.real, current.rel));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isScannedSubdir(entry.name) && current.depth + 1 <= maxDepth) queue.push({ rel, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const text = await readSmall(path.join(dir.real, rel));
      if (text === null) oversized += 1;
      else files.push({ rel, text });
    }
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const warnings = oversized > 0 ? [`${oversized} files are too large (over 256 KB) and were skipped`] : [];
  return { files, truncated, warnings };
}

async function listEntries(absolute: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(absolute, { withFileTypes: true });
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/** Đọc file nếu không quá MAX_FILE_BYTES; trả về null nếu quá lớn hoặc không đọc được. */
async function readSmall(absolute: string): Promise<string | null> {
  try {
    const info = await stat(absolute);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(absolute, 'utf8');
  } catch {
    return null;
  }
}
