/**
 * Helper dùng chung cho các detector: kiểu nháp, cắt khối cân bằng ngoặc, tách tham số, đổi tên.
 * Mọi hàm là thuần; detector chỉ dùng regex tuyến tính và các hàm này, không eval.
 */
import type { SchemaCollection, SchemaField, SchemaIndex, SchemaRelation } from '../../shared/api.ts';
import type { ScanFile } from '../schema-scan.ts';

export type { ScanFile };

/** Kết quả một detector trên toàn bộ file. */
export type Draft = {
  collections: SchemaCollection[];
  relations: SchemaRelation[];
  warnings: string[];
};

export type Detector = { id: string; detect(files: ScanFile[]): Draft };

export function emptyDraft(): Draft {
  return { collections: [], relations: [], warnings: [] };
}

export function fieldOf(name: string, type: string, extra: Partial<SchemaField> = {}): SchemaField {
  return { name, type, required: false, pk: false, array: false, inferred: false, children: [], ...extra };
}

export function collectionOf(partial: Pick<SchemaCollection, 'name' | 'orm' | 'confidence'> & Partial<SchemaCollection>): SchemaCollection {
  return {
    model: null,
    file: null,
    origin: 'static',
    fields: [],
    indexes: [],
    ...partial,
  };
}

export function indexOf(keys: string[], extra: Partial<SchemaIndex> = {}): SchemaIndex {
  return { name: keys.join('_'), keys, unique: false, ttl: false, ...extra };
}

/** Tên lớp PHP/TS/Prisma dạng snake_case, ví dụ "AuditLog" → "audit_log". */
export function snakeOf(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Tên mặc định của collection Mongoose: tên model chữ thường, thêm "s". */
export function pluralOf(name: string): string {
  return `${name.toLowerCase()}s`;
}

/** Phần cuối của tên có namespace: "\App\Models\Customer" → "Customer". */
export function lastSegment(name: string): string {
  return name.split(/[\\/.]/).pop() ?? name;
}

/**
 * Vị trí của dấu đóng ngoặc khớp với dấu mở tại open (đếm {}, [], ()); bỏ qua nội dung chuỗi.
 *
 * Returns:
 *   Chỉ số dấu đóng, hoặc -1 nếu không khớp.
 */
export function closeIndex(text: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const expected: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (pairs[ch]) expected.push(pairs[ch] as string);
    else if (ch === '}' || ch === ']' || ch === ')') {
      if (expected.pop() !== ch) return -1;
      if (expected.length === 0) return i;
    }
  }
  return -1;
}

/** Nội dung bên trong cặp ngoặc bắt đầu tại open; chuỗi rỗng nếu không khớp. */
export function insideOf(text: string, open: number): string {
  const close = closeIndex(text, open);
  return close === -1 ? '' : text.slice(open + 1, close);
}

/**
 * Tách chuỗi theo dấu phẩy ở cấp cao nhất (không nằm trong ngoặc hay chuỗi).
 */
export function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** Chuỗi trong nháy đơn/kép đầu tiên của đoạn; null nếu không có. */
export function quotedIn(text: string): string | null {
  const match = /['"]([^'"]+)['"]/.exec(text);
  return match?.[1] ?? null;
}
