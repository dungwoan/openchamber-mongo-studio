/**
 * Hiển thị giá trị Extended JSON: ô bảng ngắn gọn, JSON đầy đủ và cây có thể thu gọn.
 */
import { h } from './dom.ts';

type Obj = Record<string, unknown>;

const NUMBER_WRAPPERS = ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'];
/** Các dạng Extended JSON biểu diễn một giá trị đơn, không phải đối tượng để mở ra. */
const SCALAR_KEYS = new Set(['$oid', '$date', '$regularExpression', '$timestamp', '$binary', '$uuid', ...NUMBER_WRAPPERS]);

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalarWrapper(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && SCALAR_KEYS.has(keys[0] as string);
}

/** Đổi $date (chuỗi, số hoặc $numberLong) thành chuỗi ISO. */
function dateText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return new Date(raw).toISOString();
  if (isObject(raw) && typeof raw.$numberLong === 'string') return new Date(Number(raw.$numberLong)).toISOString();
  return String(raw);
}

/** Nội dung ngắn cho một ô của bảng; chi tiết đầy đủ xem ở JSON hoặc Tree. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (!isObject(value)) return String(value);
  if ('$oid' in value) return String(value.$oid);
  if ('$date' in value) return dateText(value.$date);
  const wrapper = NUMBER_WRAPPERS.find((key) => key in value);
  if (wrapper) return String(value[wrapper]);
  if ('$regularExpression' in value) return regexText(value.$regularExpression);
  if ('$binary' in value) return 'Binary';
  if ('$timestamp' in value) return 'Timestamp';
  return `{…} (${Object.keys(value).length} fields)`;
}

function regexText(raw: unknown): string {
  if (!isObject(raw)) return '/regex/';
  return `/${String(raw.pattern ?? '')}/${String(raw.options ?? '')}`;
}

/** Kiểu hiển thị của một giá trị, dùng cho nhãn trong cây và badge. */
export function typeLabel(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value);
  if (keys.length === 1) return keys[0]?.replace(/^\$/, '') ?? 'object';
  return 'object';
}

/** JSON đẹp mắt của giá trị (Extended JSON canonical). */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Lấy tên hiển thị của document: _id dạng ngắn, hoặc "(không có _id)". */
export function idText(doc: unknown): string {
  if (!isObject(doc) || !('_id' in doc)) return '(không có _id)';
  return cellText(doc._id);
}

/**
 * Dựng cây JSON có thể thu gọn cho một giá trị.
 *
 * Args:
 *   value: Giá trị cần hiển thị.
 *   label: Khoá của giá trị trong cha, hoặc null cho gốc.
 *   depth: Độ sâu hiện tại; mở sẵn 2 cấp đầu.
 *
 * Returns:
 *   Phần tử DOM của nút cây.
 */
export function treeNode(value: unknown, label: string | null, depth = 0): HTMLElement {
  const isContainer = typeof value === 'object' && value !== null && !isScalarWrapper(value);
  if (!isContainer) {
    const row = h('div', 'ms-tree-row');
    if (label !== null) row.appendChild(h('span', 'ms-tree-key', `${label}: `));
    row.appendChild(h('span', `ms-tree-value ms-type-${typeLabel(value)}`, cellText(value)));
    return row;
  }
  const entries = Object.entries(value as Obj);
  const details = h('details', 'ms-tree-node');
  details.open = depth < 2;
  const summary = h('summary', 'ms-tree-row');
  if (label !== null) summary.appendChild(h('span', 'ms-tree-key', `${label}: `));
  const kind = Array.isArray(value) ? `Array(${entries.length})` : `Object(${entries.length})`;
  summary.appendChild(h('span', 'ms-tree-value ms-muted', kind));
  details.appendChild(summary);
  if (depth > 12) {
    details.appendChild(h('div', 'ms-tree-row ms-muted', '…(quá sâu, xem JSON)'));
    return details;
  }
  for (const [key, child] of entries) {
    details.appendChild(treeNode(child, key, depth + 1));
  }
  return details;
}
