/**
 * Tìm chuỗi kết nối MongoDB trong file cấu hình của đúng một thư mục dự án.
 *
 * Bảo mật: chỉ đọc đúng các tên file trong danh sách cố định; không đi lên thư mục cha;
 * file là symlink trỏ ra ngoài thư mục dự án thì bị bỏ qua. URI không bao giờ rời service.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { HttpError } from './errors.ts';
import { type EnvEntry, parseCompose, parseDotenv } from './env-file.ts';
import { uriProblem } from './uri.ts';

/** Các file được phép đọc, theo thứ tự ưu tiên. */
export const PROJECT_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  'docker-compose.yml',
  'compose.yml',
] as const;

/** Tên biến được coi là chuỗi kết nối, theo thứ tự ưu tiên. Tên không phân biệt hoa thường. */
export const URI_KEYS = ['MONGODB_URI', 'MONGO_URI', 'MONGODB_URL', 'DATABASE_URL', 'MONGODB_DSN'] as const;

export const MAX_FILE_BYTES = 256 * 1024;
/** Số thư mục con tối đa được quét; vượt quá thì chỉ quét cấp gốc. */
export const MAX_SUBDIRS = 100;
/** Thư mục con bị loại khỏi quét (ngoài các tên ẩn, venv*, *.egg-info). */
const SKIP_DIR_NAMES = new Set(['node_modules', 'vendor', 'dist', 'build', '.git', '__pycache__']);
const MAX_PATH = 4096;
const MONGO_SCHEME = /^mongodb(\+srv)?:\/\//;

/** Thư mục dự án đã kiểm tra: key là đường dẫn người dùng gửi (đã chuẩn hoá), real là đường dẫn thật. */
export type ProjectDir = { key: string; real: string };

/** Kết quả tìm được trong file: một URI dùng được, hoặc URI sai (để báo người dùng). */
export type Detection =
  | { kind: 'found'; uri: string; sourceFile: string; key: string }
  | { kind: 'invalid'; sourceFile: string; key: string; problem: string };

/** Thông báo chung cho mọi lỗi đường dẫn; không lặp lại đường dẫn người dùng gửi. */
function badDirectory(): HttpError {
  return new HttpError(400, 'BAD_DIRECTORY', 'Đường dẫn dự án không hợp lệ. Cần đường dẫn tuyệt đối tới một thư mục có thật.');
}

/**
 * Kiểm tra và chuẩn hoá thư mục dự án do panel gửi.
 *
 * Args:
 *   input: Giá trị directory trong body JSON.
 *
 * Returns:
 *   Hai đường dẫn: đã chuẩn hoá và đã giải symlink.
 *
 * Raises:
 *   HttpError 400: Không phải chuỗi, không tuyệt đối, có thành phần "..", có NUL, hoặc không phải thư mục.
 */
export async function resolveProjectDir(input: unknown): Promise<ProjectDir> {
  if (typeof input !== 'string' || input.trim() === '' || input.length > MAX_PATH || input.includes('\0')) {
    throw badDirectory();
  }
  if (!path.isAbsolute(input) || input.split(/[\\/]/).includes('..')) throw badDirectory();
  const key = path.normalize(input);
  let real: string;
  try {
    real = await realpath(key);
  } catch {
    throw badDirectory();
  }
  const info = await stat(real);
  if (!info.isDirectory()) throw badDirectory();
  return { key, real };
}

/**
 * Thư mục target có nằm trong root (hoặc chính là root) không.
 *
 * Args:
 *   root: Đường dẫn thật của thư mục dự án.
 *   target: Đường dẫn thật cần kiểm tra.
 */
export function isInside(root: string, target: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(prefix);
}

/** Đọc một file trong allowlist; trả về null nếu không có, không đọc được, hoặc không an toàn. */
async function readAllowed(dir: ProjectDir, name: string): Promise<string | null> {
  let target: string;
  try {
    target = await realpath(path.join(dir.real, name));
  } catch {
    return null;
  }
  if (!isInside(dir.real, target)) {
    console.warn(`mongo-studio: bỏ qua ${name} vì trỏ ra ngoài thư mục dự án`);
    return null;
  }
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(target, 'utf8');
  } catch {
    console.warn(`mongo-studio: không đọc được ${name} của dự án`);
    return null;
  }
}

/** Phân tích nội dung một file theo loại của nó. */
function entriesOf(name: string, text: string): EnvEntry[] {
  return name.endsWith('.yml') ? parseCompose(text) : parseDotenv(text);
}

/** Giá trị cuối cùng của mỗi biến, khoá viết hoa; dòng sau ghi đè dòng trước như dotenv. */
function lastValues(entries: EnvEntry[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const { key, value } of entries) values.set(key.toUpperCase(), value);
  return values;
}

/**
 * Chọn chuỗi kết nối từ nội dung các file (hàm thuần).
 * File ưu tiên trước; trong một file, URI_KEYS theo thứ tự. URI sai bị bỏ qua, chỉ báo khi không còn URI đúng nào.
 *
 * Args:
 *   files: Các file theo đúng thứ tự ưu tiên, kèm nội dung.
 *
 * Returns:
 *   URI dùng được, hoặc URI sai đầu tiên gặp phải, hoặc null nếu không có gì.
 */
export function pickUri(files: Array<{ name: string; text: string }>): Detection | null {
  let invalid: Detection | null = null;
  for (const { name, text } of files) {
    const values = lastValues(entriesOf(name, text));
    for (const key of URI_KEYS) {
      const raw = values.get(key);
      if (raw === undefined) continue;
      const value = raw.trim();
      if (!MONGO_SCHEME.test(value)) continue;
      const problem = uriProblem(value);
      if (problem === null) return { kind: 'found', uri: value, sourceFile: name, key };
      invalid ??= { kind: 'invalid', sourceFile: name, key, problem };
    }
  }
  return invalid;
}

/** Thư mục con được quét: không ẩn, không thuộc danh sách loại trừ, không phải venv/egg-info. */
export function isScannedSubdir(name: string): boolean {
  if (name.startsWith('.') || SKIP_DIR_NAMES.has(name)) return false;
  return !(name.startsWith('venv') || name.endsWith('.egg-info'));
}

/**
 * Các thư mục con trực tiếp cần quét, theo tên. Symlink thư mục không được liệt kê (Dirent không coi là thư mục).
 * Quá MAX_SUBDIRS thư mục thì trả về rỗng: chỉ quét cấp gốc, tránh quét repo lớn.
 */
async function scannedSubdirs(dir: ProjectDir): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir.real, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && isScannedSubdir(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length > MAX_SUBDIRS) {
    console.warn(`mongo-studio: dự án có ${names.length} thư mục con, chỉ quét cấp gốc`);
    return [];
  }
  return names;
}

/** Đọc các đường dẫn tương đối trong allowlist; bỏ qua file không đọc được. */
async function readAll(dir: ProjectDir, relatives: string[]): Promise<Array<{ name: string; text: string }>> {
  const files: Array<{ name: string; text: string }> = [];
  for (const rel of relatives) {
    const text = await readAllowed(dir, rel);
    if (text !== null) files.push({ name: rel, text });
  }
  return files;
}

/**
 * Đọc các file cấu hình của dự án: gốc trước, rồi cấp con một cấp (theo tên thư mục).
 * URI dùng được ở cấp đầu tiên thắng; URI sai ở gốc không chặn URI đúng ở con.
 *
 * Args:
 *   dir: Thư mục dự án đã kiểm tra bằng resolveProjectDir.
 *
 * Returns:
 *   Kết quả tìm được, hoặc null nếu dự án không có file nào hợp lệ.
 */
export async function detectProjectUri(dir: ProjectDir): Promise<Detection | null> {
  const root = await readAll(dir, [...PROJECT_FILES]);
  const rootResult = pickUri(root);
  if (rootResult?.kind === 'found') return rootResult;
  const subdirs = await scannedSubdirs(dir);
  if (subdirs.length === 0) return rootResult;
  const nested = await readAll(dir, subdirs.flatMap((sub) => PROJECT_FILES.map((file) => `${sub}/${file}`)));
  return pickUri([...root, ...nested]);
}
