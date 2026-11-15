/**
 * Đọc file cấu hình của dự án: .env kiểu dotenv và docker-compose (chỉ mục environment).
 * Hàm thuần: không đọc đĩa, không ghi, không đặt biến vào process.env.
 *
 * Giới hạn có chủ đích: không hỗ trợ giá trị nhiều dòng, YAML anchor hay include.
 */

export type EnvEntry = { key: string; value: string };

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const COMPOSE_LINE = /^\s*-?\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*(.*)$/;

/**
 * Đọc giá trị đặt trong nháy đơn hoặc nháy kép; trong nháy kép hỗ trợ \" \\ \n.
 *
 * Args:
 *   rest: Phần văn bản bắt đầu bằng dấu nháy mở.
 *
 * Returns:
 *   Giá trị đã bỏ nháy, hoặc null nếu thiếu nháy đóng (dòng bị bỏ qua).
 */
function quotedValue(rest: string): string | null {
  const quote = rest[0];
  let out = '';
  for (let i = 1; i < rest.length; i += 1) {
    const ch = rest[i] as string;
    if (quote === '"' && ch === '\\' && i + 1 < rest.length) {
      const next = rest[i + 1] as string;
      if (next === 'n') out += '\n';
      else if (next === '"' || next === '\\') out += next;
      else out += `\\${next}`;
      i += 1;
      continue;
    }
    if (ch === quote) return out;
    out += ch;
  }
  return null;
}

/** Giá trị không nháy: bỏ comment bắt đầu bằng " #" và khoảng trắng thừa. */
function unquotedValue(rest: string): string {
  const hash = rest.search(/(^|\s)#/);
  return (hash === -1 ? rest : rest.slice(0, hash)).trim();
}

/** Một dòng KEY=VALUE theo dotenv; trả về null nếu dòng không hợp lệ. */
function dotenvLine(raw: string): EnvEntry | null {
  const line = raw.trim();
  if (line === '' || line.startsWith('#')) return null;
  const body = line.replace(/^export\s+/, '');
  const eq = body.indexOf('=');
  if (eq === -1) return null;
  const key = body.slice(0, eq).trim();
  if (!KEY_PATTERN.test(key)) return null;
  const rest = body.slice(eq + 1).trimStart();
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const value = quotedValue(rest);
    return value === null ? null : { key, value };
  }
  return { key, value: unquotedValue(rest) };
}

/**
 * Tách nội dung file .env thành các cặp KEY=VALUE.
 *
 * Args:
 *   text: Nội dung file.
 *
 * Returns:
 *   Danh sách cặp theo đúng thứ tự xuất hiện; dòng sai bị bỏ qua.
 */
export function parseDotenv(text: string): EnvEntry[] {
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map(dotenvLine)
    .filter((entry): entry is EnvEntry => entry !== null);
}

/**
 * Lấy các dòng KEY: value hoặc - KEY=value trong docker-compose.yml.
 *
 * Args:
 *   text: Nội dung file compose.
 *
 * Returns:
 *   Danh sách cặp theo đúng thứ tự xuất hiện. Giá trị như ${VAR} được giữ nguyên để nơi gọi bỏ qua.
 */
export function parseCompose(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = COMPOSE_LINE.exec(raw);
    if (!match) continue;
    const key = match[1] as string;
    const rest = (match[2] ?? '').trim();
    if (rest === '' || rest.startsWith('#')) continue;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const value = quotedValue(rest);
      if (value !== null) entries.push({ key, value });
      continue;
    }
    entries.push({ key, value: unquotedValue(rest) });
  }
  return entries;
}
