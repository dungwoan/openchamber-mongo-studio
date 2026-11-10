/**
 * Parser cho cú pháp kiểu mongo shell. Không dùng eval, new Function hay vm:
 * chỉ nhận một tập lệnh và hàm dựng BSON cố định, còn lại báo lỗi cú pháp kèm vị trí.
 *
 * Dùng chung cho page (kiểm tra cú pháp trước khi lưu) và service (chạy lệnh).
 * Không phụ thuộc Node hay driver: giá trị BSON được biểu diễn dạng Extended JSON
 * (ví dụ ObjectId("...") -> { "$oid": "..." }) và service đổi sang kiểu BSON thật.
 */

/** Đối tượng JSON thuần (không phải mảng). */
export type Obj = Record<string, unknown>;

/** Lỗi cú pháp kèm vị trí (dòng và cột tính từ 1). */
export class QuerySyntaxError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  /**
   * Args:
   *   message: Mô tả lỗi bằng tiếng Việt.
   *   offset: Vị trí ký tự (tính từ 0) trong chuỗi nguồn.
   *   source: Toàn bộ chuỗi nguồn, dùng để tính dòng và cột.
   */
  constructor(message: string, offset: number, source: string) {
    const before = source.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - before.lastIndexOf('\n');
    super(`Lỗi cú pháp tại dòng ${line}, cột ${column}: ${message}`);
    this.name = 'QuerySyntaxError';
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

export type ChainCall = {
  method: string;
  args: unknown[];
  offset: number;
};

export type FindCommand = {
  kind: 'find';
  collection: string;
  filter: Obj;
  projection?: Obj;
  sort?: Obj;
  skip?: number;
  limit?: number;
};

export type Command =
  | { kind: 'collectionNames' }
  | { kind: 'stats' }
  | FindCommand
  | { kind: 'findOne'; collection: string; filter: Obj; projection?: Obj }
  | { kind: 'count'; collection: string; filter: Obj }
  | { kind: 'distinct'; collection: string; field: string; filter: Obj }
  | {
      kind: 'aggregate';
      collection: string;
      stages: Obj[];
      options: { allowDiskUse?: boolean; maxTimeMS?: number };
    }
  | { kind: 'insertOne'; collection: string; document: Obj }
  | { kind: 'insertMany'; collection: string; documents: Obj[] }
  | { kind: 'updateOne' | 'updateMany'; collection: string; filter: Obj; update: Obj }
  | { kind: 'deleteOne' | 'deleteMany'; collection: string; filter: Obj };

export type CommandKind = Command['kind'];

/** Một lệnh trong chuỗi nhiều lệnh; start/end là vị trí trong chuỗi nguồn. */
export type Statement = {
  start: number;
  end: number;
  command: Command;
};

type TokenKind = 'ident' | 'string' | 'number' | 'regex' | 'punct' | 'eof';

type Token = {
  kind: TokenKind;
  value: string;
  pos: number;
  end: number;
  flags?: string;
};

const MAX_DEPTH = 100;
const PUNCTUATION = '()[]{},:;.-';
const NUMBER_RE = /0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const REGEX_FLAGS = 'imsux';
const CONSTRUCTORS = ['ObjectId', 'ISODate', 'Date', 'NumberLong', 'NumberInt', 'NumberDecimal', 'UUID'];
const COLLECTION_METHODS: Record<string, { min: number; max: number }> = {
  find: { min: 0, max: 2 },
  findOne: { min: 0, max: 2 },
  count: { min: 0, max: 1 },
  countDocuments: { min: 0, max: 1 },
  distinct: { min: 1, max: 2 },
  aggregate: { min: 1, max: 2 },
  insertOne: { min: 1, max: 1 },
  insertMany: { min: 1, max: 1 },
  updateOne: { min: 2, max: 2 },
  updateMany: { min: 2, max: 2 },
  deleteOne: { min: 1, max: 1 },
  deleteMany: { min: 1, max: 1 },
};
const WRITE_KINDS = new Set<CommandKind>([
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
]);
const AGGREGATE_OPTIONS = new Set(['allowDiskUse', 'maxTimeMS']);
const DB_METHODS = ['getCollectionNames', 'stats'];

/**
 * Chuyển chuỗi thành các token; bỏ qua khoảng trắng và comment.
 *
 * Args:
 *   source: Chuỗi cần tách.
 *
 * Returns:
 *   Danh sách token, luôn kết thúc bằng token eof.
 *
 * Raises:
 *   QuerySyntaxError: Gặp chuỗi, regex hoặc ký tự không hợp lệ.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch)) {
      i++;
    } else if (source.startsWith('//', i)) {
      i = skipLineComment(source, i);
    } else if (source.startsWith('/*', i)) {
      i = skipBlockComment(source, i);
    } else {
      const token = readToken(source, i);
      tokens.push(token);
      i = token.end;
    }
  }
  tokens.push({ kind: 'eof', value: '', pos: source.length, end: source.length });
  return tokens;
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf('\n', start);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source: string, start: number): number {
  const close = source.indexOf('*/', start + 2);
  if (close === -1) throw new QuerySyntaxError('Comment /* chưa đóng', start, source);
  return close + 2;
}

function readToken(source: string, start: number): Token {
  const ch = source[start] as string;
  if (ch === '"' || ch === "'") return readString(source, start);
  if (ch === '/') return readRegex(source, start);
  if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[start + 1] ?? ''))) {
    return readMatch(source, start, NUMBER_RE, 'number');
  }
  if (/[A-Za-z_$]/.test(ch)) return readMatch(source, start, IDENT_RE, 'ident');
  if (PUNCTUATION.includes(ch)) return { kind: 'punct', value: ch, pos: start, end: start + 1 };
  throw new QuerySyntaxError(`Ký tự không hợp lệ '${ch}'`, start, source);
}

function readMatch(source: string, start: number, re: RegExp, kind: TokenKind): Token {
  re.lastIndex = start;
  const match = re.exec(source);
  const text = match ? match[0] : '';
  if (!match || text.length === 0) {
    throw new QuerySyntaxError('Không đọc được nội dung', start, source);
  }
  return { kind, value: text, pos: start, end: start + text.length };
}

function readString(source: string, start: number): Token {
  const quote = source[start];
  let value = '';
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === quote) return { kind: 'string', value, pos: start, end: i + 1 };
    if (ch === '\n' || ch === '\r') break;
    if (ch === '\\') {
      const escaped = readEscape(source, i);
      value += escaped.text;
      i = escaped.next;
    } else {
      value += ch;
      i++;
    }
  }
  throw new QuerySyntaxError('Chuỗi chưa đóng dấu nháy', start, source);
}

function readEscape(source: string, slash: number): { text: string; next: number } {
  const code = source[slash + 1];
  if (code === undefined) throw new QuerySyntaxError('Dấu \\ ở cuối chuỗi', slash, source);
  const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
  if (code in simple) return { text: simple[code] as string, next: slash + 2 };
  if (code === 'x' || code === 'u') {
    const width = code === 'x' ? 2 : 4;
    const hex = source.slice(slash + 2, slash + 2 + width);
    if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
      throw new QuerySyntaxError(`Ký tự thoát \\${code} không hợp lệ`, slash, source);
    }
    return { text: String.fromCharCode(parseInt(hex, 16)), next: slash + 2 + width };
  }
  return { text: code, next: slash + 2 };
}

function readRegex(source: string, start: number): Token {
  let pattern = '';
  let inClass = false;
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') break;
    if (ch === '\\') {
      pattern += ch + (source[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '/' && !inClass) return readRegexFlags(source, start, pattern, i + 1);
    if (ch === '[') inClass = true;
    if (ch === ']') inClass = false;
    pattern += ch;
    i++;
  }
  throw new QuerySyntaxError("Regex chưa đóng bằng '/'", start, source);
}

function readRegexFlags(source: string, start: number, pattern: string, from: number): Token {
  let end = from;
  while (end < source.length && /[a-z]/.test(source[end] as string)) end++;
  const flags = source.slice(from, end);
  for (const flag of flags) {
    if (!REGEX_FLAGS.includes(flag)) {
      throw new QuerySyntaxError(`Cờ regex '${flag}' không được hỗ trợ (dùng i, m, s, x, u)`, start, source);
    }
  }
  return { kind: 'regex', value: pattern, flags, pos: start, end };
}

/** Giá trị số từ token; hỗ trợ số thập lục phân 0x. */
function numberValue(raw: string): number {
  return /^0[xX]/.test(raw) ? parseInt(raw.slice(2), 16) : Number(raw);
}

function defineKey(obj: Obj, key: string, value: unknown): void {
  // defineProperty để khoá như __proto__ thành khoá thường, không đổi prototype.
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function isPlainObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeToken(token: Token): string {
  if (token.kind === 'eof') return 'hết lệnh';
  if (token.kind === 'string') return `"${token.value}"`;
  if (token.kind === 'regex') return `/${token.value}/`;
  return `'${token.value}'`;
}

/** Bộ đọc token và các quy tắc cú pháp, viết theo kiểu đệ quy đi xuống. */
class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  /** Đọc toàn bộ chương trình thành danh sách lệnh. */
  parseProgram(): Statement[] {
    const statements: Statement[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.acceptPunct(';')) continue;
      const first = this.peek();
      const command = this.parseCommand();
      const last = this.tokens[this.index - 1] as Token;
      statements.push({ start: first.pos, end: last.end, command });
      if (this.peek().kind !== 'eof') this.expectPunct(';', 'sau mỗi lệnh');
    }
    return statements;
  }

  /** Đọc đúng một giá trị và bắt buộc hết chuỗi. */
  parseSingleValue(): unknown {
    const value = this.parseValue(1);
    this.acceptPunct(';');
    if (this.peek().kind !== 'eof') this.fail(`Thừa nội dung ${describeToken(this.peek())}`);
    return value;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)] as Token;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'eof') this.index++;
    return token;
  }

  private isPunct(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === 'punct' && token.value === value;
  }

  private acceptPunct(value: string): boolean {
    if (!this.isPunct(value)) return false;
    this.next();
    return true;
  }

  private expectPunct(value: string, context = ''): void {
    if (this.acceptPunct(value)) return;
    const where = context ? ` ${context}` : '';
    this.fail(`Cần '${value}'${where}, nhưng gặp ${describeToken(this.peek())}`);
  }

  private expectIdent(context: string): Token {
    const token = this.peek();
    if (token.kind !== 'ident') this.fail(`Cần tên ${context}, nhưng gặp ${describeToken(token)}`);
    return this.next();
  }

  private fail(message: string, offset = this.peek().pos): never {
    throw new QuerySyntaxError(message, offset, this.source);
  }

  private parseCommand(): Command {
    const head = this.peek();
    if (head.kind !== 'ident' || head.value !== 'db') {
      this.fail("Lệnh phải bắt đầu bằng 'db', ví dụ db.users.find({})");
    }
    this.next();
    this.expectPunct('.', 'sau db');
    const name = this.expectIdent('sau db.');
    if (this.isPunct('(')) return this.parseDbCall(name);
    return this.parseCollectionPath(name.value);
  }

  private parseDbCall(name: Token): Command {
    if (name.value === 'getCollection') {
      const args = this.parseArgs();
      if (args.length !== 1 || typeof args[0] !== 'string') {
        this.fail('db.getCollection(...) cần đúng một chuỗi tên collection', name.pos);
      }
      if (!this.isPunct('.')) this.fail('Thiếu hàm sau db.getCollection(...), ví dụ .find({})', name.pos);
      this.next();
      const method = this.expectIdent('hàm collection');
      return this.finishCall(args[0] as string, method);
    }
    if (!DB_METHODS.includes(name.value)) {
      this.fail(
        `Không hỗ trợ 'db.${name.value}()'. Hỗ trợ: getCollectionNames(), stats(), getCollection("tên")`,
        name.pos,
      );
    }
    if (this.parseArgs().length > 0) this.fail(`db.${name.value}() không nhận tham số`, name.pos);
    if (this.isPunct('.')) this.fail(`Không nối thêm hàm sau db.${name.value}()`, this.peek().pos);
    return { kind: name.value === 'stats' ? 'stats' : 'collectionNames' };
  }

  /** Đọc đường dẫn collection (có thể chứa dấu chấm) và hàm đứng sau cùng. */
  private parseCollectionPath(first: string): Command {
    let collection = first;
    while (this.isPunct('.')) {
      this.next();
      const segment = this.expectIdent('sau dấu chấm');
      if (this.isPunct('(')) return this.finishCall(collection, segment);
      collection += `.${segment.value}`;
    }
    this.fail(`Thiếu hàm sau 'db.${collection}', ví dụ db.${collection}.find({})`);
  }

  /** Đọc tham số của hàm rồi các hàm nối tiếp (.sort, .limit...) và kiểm tra. */
  private finishCall(collection: string, method: Token): Command {
    if (!COLLECTION_METHODS[method.value]) {
      this.fail(
        `Không hỗ trợ 'db.${collection}.${method.value}()'. Hỗ trợ: ${Object.keys(COLLECTION_METHODS).join(', ')}`,
        method.pos,
      );
    }
    const args = this.parseArgs();
    const chain: ChainCall[] = [];
    while (this.isPunct('.')) {
      this.next();
      const callName = this.expectIdent('hàm nối tiếp');
      chain.push({ method: callName.value, args: this.parseArgs(), offset: callName.pos });
    }
    return buildCommand(collection, method, args, chain, (message, offset) => this.fail(message, offset));
  }

  private parseArgs(): unknown[] {
    this.expectPunct('(');
    const args: unknown[] = [];
    while (!this.acceptPunct(')')) {
      args.push(this.parseValue(1));
      if (!this.acceptPunct(',')) {
        this.expectPunct(')', 'để đóng tham số');
        break;
      }
    }
    return args;
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_DEPTH) this.fail(`Dữ liệu lồng quá sâu (tối đa ${MAX_DEPTH} cấp)`);
    const token = this.peek();
    if (token.kind === 'string') return this.next().value;
    if (token.kind === 'number') return numberValue(this.next().value);
    if (token.kind === 'regex') {
      this.next();
      return { $regularExpression: { pattern: token.value, options: token.flags ?? '' } };
    }
    if (token.kind === 'punct') return this.parsePunctValue(depth);
    if (token.kind === 'ident') return this.parseIdentValue();
    return this.fail(`Thiếu giá trị, gặp ${describeToken(token)}`);
  }

  private parsePunctValue(depth: number): unknown {
    if (this.isPunct('{')) return this.parseObject(depth);
    if (this.isPunct('[')) return this.parseArray(depth);
    if (this.isPunct('-') && this.peek(1).kind === 'number') {
      this.next();
      return -numberValue(this.next().value);
    }
    return this.fail(`Giá trị không hợp lệ ${describeToken(this.peek())}`);
  }

  private parseIdentValue(): unknown {
    const token = this.peek();
    if (token.value === 'true' || token.value === 'false') {
      this.next();
      return token.value === 'true';
    }
    if (token.value === 'null') {
      this.next();
      return null;
    }
    if (token.value === 'new') {
      this.next();
      const ctor = this.expectIdent('sau new');
      if (!CONSTRUCTORS.includes(ctor.value)) this.fail(`Không hỗ trợ 'new ${ctor.value}()'`, ctor.pos);
      return this.parseConstructor(ctor.value, ctor.pos);
    }
    if (CONSTRUCTORS.includes(token.value) && this.isPunct('(', 1)) {
      this.next();
      if (token.value === 'Date') this.fail("Dùng 'new Date(...)' hoặc ISODate(...)", token.pos);
      return this.parseConstructor(token.value, token.pos);
    }
    if (this.isPunct('(', 1)) {
      this.fail(`Không hỗ trợ hàm '${token.value}()'. Hỗ trợ: ${CONSTRUCTORS.join(', ')}`);
    }
    return this.fail(
      `Giá trị không hợp lệ '${token.value}'. Dùng chuỗi "...", số, true, false, null hoặc hàm dựng BSON`,
    );
  }

  private parseConstructor(name: string, offset: number): unknown {
    const args = this.parseArgs();
    const fail = (message: string): never => this.fail(message, offset);
    return buildConstructor(name, args, fail);
  }

  private parseObject(depth: number): Obj {
    this.expectPunct('{');
    const obj: Obj = {};
    while (!this.acceptPunct('}')) {
      const keyToken = this.next();
      const key = this.objectKey(keyToken);
      if (Object.prototype.hasOwnProperty.call(obj, key)) this.fail(`Khoá '${key}' bị lặp`, keyToken.pos);
      this.expectPunct(':', 'sau tên khoá');
      defineKey(obj, key, this.parseValue(depth + 1));
      if (!this.acceptPunct(',')) {
        this.expectPunct('}', 'để đóng đối tượng');
        break;
      }
    }
    return obj;
  }

  private objectKey(token: Token): string {
    if (token.kind === 'ident' || token.kind === 'string' || token.kind === 'number') return token.value;
    return this.fail(`Khoá phải là tên, chuỗi hoặc số, gặp ${describeToken(token)}`, token.pos);
  }

  private parseArray(depth: number): unknown[] {
    this.expectPunct('[');
    const items: unknown[] = [];
    while (!this.acceptPunct(']')) {
      items.push(this.parseValue(depth + 1));
      if (!this.acceptPunct(',')) {
        this.expectPunct(']', 'để đóng mảng');
        break;
      }
    }
    return items;
  }
}

type Failer = (message: string, offset: number) => never;

/** Đổi tham số hàm dựng BSON thành dạng Extended JSON. */
function buildConstructor(name: string, args: unknown[], fail: (message: string) => never): unknown {
  const [arg] = args;
  const expectArity = (min: number, max: number): void => {
    if (args.length < min || args.length > max) fail(`${name}() nhận ${min === max ? min : `${min}-${max}`} tham số`);
  };
  switch (name) {
    case 'ObjectId':
      expectArity(1, 1);
      if (typeof arg !== 'string' || !/^[0-9a-fA-F]{24}$/.test(arg)) fail('ObjectId cần chuỗi 24 ký tự hex');
      return { $oid: (arg as string).toLowerCase() };
    case 'ISODate':
    case 'Date':
      expectArity(0, 1);
      return { $date: dateArgument(arg, args.length, fail) };
    case 'NumberLong':
      expectArity(1, 1);
      if (typeof arg === 'number' && !Number.isSafeInteger(arg)) fail('NumberLong(số) cần số nguyên an toàn; dùng chuỗi cho số lớn');
      if (typeof arg === 'string' && !/^[+-]?\d+$/.test(arg)) fail('NumberLong cần chuỗi số nguyên');
      if (typeof arg !== 'string' && typeof arg !== 'number') fail('NumberLong cần chuỗi hoặc số');
      return { $numberLong: String(arg) };
    case 'NumberInt':
      expectArity(1, 1);
      if (typeof arg !== 'number' || !Number.isInteger(arg) || arg < -2147483648 || arg > 2147483647) {
        fail('NumberInt cần số nguyên trong khoảng 32-bit');
      }
      return { $numberInt: String(arg) };
    case 'NumberDecimal':
      expectArity(1, 1);
      if (typeof arg !== 'string' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(arg)) {
        fail('NumberDecimal cần chuỗi số thập phân, ví dụ "12.50"');
      }
      return { $numberDecimal: arg };
    case 'UUID':
      expectArity(1, 1);
      return { $uuid: uuidArgument(arg, fail) };
    default:
      return fail(`Không hỗ trợ ${name}()`);
  }
}

function dateArgument(arg: unknown, count: number, fail: (message: string) => never): string | number {
  if (count === 0) return new Date().toISOString();
  if (typeof arg === 'number' && Number.isFinite(arg)) return arg;
  if (typeof arg !== 'string') fail('Ngày cần chuỗi ISO 8601 hoặc số mili giây');
  const time = Date.parse(arg as string);
  if (Number.isNaN(time)) fail(`Ngày không hợp lệ: "${arg}"`);
  return new Date(time).toISOString();
}

function uuidArgument(arg: unknown, fail: (message: string) => never): string {
  const hex = typeof arg === 'string' ? arg.replace(/-/g, '') : '';
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) fail('UUID cần chuỗi 32 ký tự hex (có thể có dấu -)');
  const lower = hex.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}

/** Kiểm tra số đếm cho skip/limit: số nguyên không âm, chấp nhận NumberInt/NumberLong. */
function countArgument(value: unknown, method: string, offset: number, fail: Failer): number {
  let number: unknown = value;
  if (isPlainObject(value)) {
    const wrapped = value.$numberInt ?? value.$numberLong;
    if (typeof wrapped === 'string') number = Number(wrapped);
  }
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 0) {
    fail(`${method}() cần số nguyên không âm`, offset);
  }
  return number as number;
}

function expectObject(value: unknown, what: string, offset: number, fail: Failer): Obj {
  if (!isPlainObject(value)) fail(`${what} phải là đối tượng {...}`, offset);
  return value as Obj;
}

function expectStageList(value: unknown, offset: number, fail: Failer): Obj[] {
  if (!Array.isArray(value)) fail('aggregate cần một mảng các stage: aggregate([{ $match: {...} }])', offset);
  return (value as unknown[]).map((stage) => expectObject(stage, 'Mỗi stage', offset, fail));
}

/** Gán giá trị tuỳ chọn; nếu đối số không có thì bỏ qua. */
function optionalObject(args: unknown[], index: number, offset: number, fail: Failer): Obj | undefined {
  return args.length > index ? expectObject(args[index], 'Tham số', offset, fail) : undefined;
}

function buildCommand(
  collection: string,
  method: Token,
  args: unknown[],
  chain: ChainCall[],
  fail: Failer,
): Command {
  const spec = COLLECTION_METHODS[method.value];
  if (!spec) {
    fail(
      `Không hỗ trợ 'db.${collection}.${method.value}()'. Hỗ trợ: ${Object.keys(COLLECTION_METHODS).join(', ')}`,
      method.pos,
    );
  }
  if (args.length < spec.min || args.length > spec.max) {
    fail(`${method.value}() nhận ${spec.min === spec.max ? spec.min : `${spec.min}-${spec.max}`} tham số`, method.pos);
  }
  const base = buildBaseCommand(collection, method, args, fail);
  if (base.kind === 'find') return applyFindChain(base, chain, fail);
  if (base.kind === 'aggregate' && chain.length === 1 && chain[0]?.method === 'toArray') return base;
  rejectChain(chain, method.value, fail);
  return base;
}

function rejectChain(chain: ChainCall[], method: string, fail: Failer): void {
  const first = chain[0];
  if (first) fail(`Không nối '.${first.method}()' vào ${method}()`, first.offset);
}

function buildBaseCommand(collection: string, method: Token, args: unknown[], fail: Failer): Command {
  const offset = method.pos;
  const filterAt = (index: number): Obj => optionalObject(args, index, offset, fail) ?? {};
  switch (method.value) {
    case 'find':
      return { kind: 'find', collection, filter: filterAt(0), projection: optionalObject(args, 1, offset, fail) };
    case 'findOne':
      return { kind: 'findOne', collection, filter: filterAt(0), projection: optionalObject(args, 1, offset, fail) };
    case 'count':
    case 'countDocuments':
      return { kind: 'count', collection, filter: filterAt(0) };
    case 'distinct':
      if (typeof args[0] !== 'string') fail('distinct() cần tên field dạng chuỗi đứng đầu', offset);
      return { kind: 'distinct', collection, field: args[0] as string, filter: filterAt(1) };
    case 'aggregate':
      return buildAggregate(collection, args, offset, fail);
    case 'insertOne':
      return { kind: 'insertOne', collection, document: expectObject(args[0], 'Document', offset, fail) };
    case 'insertMany':
      return buildInsertMany(collection, args[0], offset, fail);
    case 'updateOne':
    case 'updateMany':
      return buildUpdate(method.value, collection, args, offset, fail);
    default:
      return { kind: method.value as 'deleteOne' | 'deleteMany', collection, filter: filterAt(0) };
  }
}

function buildAggregate(collection: string, args: unknown[], offset: number, fail: Failer): Command {
  const stages = expectStageList(args[0], offset, fail);
  const options: { allowDiskUse?: boolean; maxTimeMS?: number } = {};
  if (args.length > 1) {
    const raw = expectObject(args[1], 'Tuỳ chọn aggregate', offset, fail);
    for (const key of Object.keys(raw)) {
      if (!AGGREGATE_OPTIONS.has(key)) fail(`Tuỳ chọn aggregate '${key}' không được hỗ trợ (allowDiskUse, maxTimeMS)`, offset);
    }
    if (raw.allowDiskUse !== undefined) options.allowDiskUse = raw.allowDiskUse === true;
    if (raw.maxTimeMS !== undefined) options.maxTimeMS = countArgument(raw.maxTimeMS, 'maxTimeMS', offset, fail);
  }
  return { kind: 'aggregate', collection, stages, options };
}

function buildInsertMany(collection: string, value: unknown, offset: number, fail: Failer): Command {
  if (!Array.isArray(value) || value.length === 0) fail('insertMany() cần một mảng document, không rỗng', offset);
  const documents = (value as unknown[]).map((doc) => expectObject(doc, 'Mỗi document', offset, fail));
  return { kind: 'insertMany', collection, documents };
}

function buildUpdate(kind: string, collection: string, args: unknown[], offset: number, fail: Failer): Command {
  const filter = expectObject(args[0], 'Filter', offset, fail);
  const update = expectObject(args[1], 'Update', offset, fail);
  const keys = Object.keys(update);
  if (keys.length === 0 || keys.some((key) => !key.startsWith('$'))) {
    fail('Update phải dùng toán tử, ví dụ { $set: { field: giá trị } }', offset);
  }
  return { kind: kind as 'updateOne' | 'updateMany', collection, filter, update };
}

/** Gắn các hàm nối tiếp vào lệnh find (sort, skip, limit, toArray). */
function applyFindChain(command: FindCommand, chain: ChainCall[], fail: Failer): FindCommand {
  const seen = new Set<string>();
  const result: FindCommand = { ...command };
  for (const call of chain) {
    if (seen.has(call.method)) fail(`Hàm '.${call.method}()' bị lặp`, call.offset);
    seen.add(call.method);
    if (call.method === 'toArray') {
      if (call.args.length > 0) fail('toArray() không nhận tham số', call.offset);
    } else if (call.method === 'sort') {
      if (call.args.length !== 1) fail('sort() cần đúng một đối tượng', call.offset);
      result.sort = expectObject(call.args[0], 'sort()', call.offset, fail);
    } else if (call.method === 'skip' || call.method === 'limit') {
      if (call.args.length !== 1) fail(`${call.method}() cần đúng một số`, call.offset);
      const count = countArgument(call.args[0], call.method, call.offset, fail);
      if (call.method === 'skip') result.skip = count;
      else result.limit = count;
    } else {
      fail(`Không hỗ trợ '.${call.method}()' sau find(). Hỗ trợ: sort, skip, limit, toArray`, call.offset);
    }
  }
  return result;
}

/**
 * Tách chuỗi nhiều lệnh (ngăn cách bởi ';') thành danh sách lệnh đã kiểm tra.
 *
 * Args:
 *   text: Nội dung trong editor.
 *
 * Returns:
 *   Danh sách lệnh theo thứ tự xuất hiện; rỗng nếu chỉ có khoảng trắng hoặc comment.
 *
 * Raises:
 *   QuerySyntaxError: Lỗi cú pháp, kèm dòng và cột.
 */
export function parseQuery(text: string): Statement[] {
  return new Parser(tokenize(text), text).parseProgram();
}

/**
 * Đọc một giá trị dạng JS literal nới lỏng (dùng cho filter, sort, document).
 *
 * Args:
 *   text: Chuỗi cần đọc, ví dụ { _id: ObjectId("...") }.
 *
 * Returns:
 *   Giá trị dạng Extended JSON.
 *
 * Raises:
 *   QuerySyntaxError: Cú pháp sai hoặc chuỗi rỗng.
 */
export function parseLiteral(text: string): unknown {
  if (text.trim() === '') throw new QuerySyntaxError('Chưa nhập nội dung', 0, text);
  return new Parser(tokenize(text), text).parseSingleValue();
}

/**
 * Chọn lệnh theo vị trí con trỏ: lệnh cuối cùng bắt đầu trước hoặc tại con trỏ.
 * Không có con trỏ thì chọn lệnh cuối.
 *
 * Args:
 *   statements: Danh sách lệnh đã parse.
 *   cursor: Vị trí con trỏ, hoặc null.
 *
 * Returns:
 *   Chỉ số lệnh, hoặc -1 nếu danh sách rỗng.
 */
export function pickStatement(statements: Statement[], cursor: number | null): number {
  if (statements.length === 0) return -1;
  if (cursor === null) return statements.length - 1;
  let index = 0;
  statements.forEach((statement, position) => {
    if (statement.start <= cursor) index = position;
  });
  return index;
}

/** Lệnh ghi dữ liệu, kể cả aggregate có $out hoặc $merge. */
export function isWriteCommand(command: Command): boolean {
  if (WRITE_KINDS.has(command.kind)) return true;
  if (command.kind !== 'aggregate') return false;
  return command.stages.some((stage) => '$out' in stage || '$merge' in stage);
}
