import { describe, expect, test } from 'bun:test';

import {
  QuerySyntaxError,
  isWriteCommand,
  parseLiteral,
  parseQuery,
  pickStatement,
  type Command,
} from './query-parser.ts';

/** Parse đúng một lệnh và trả về command, để các test ngắn gọn. */
function one(text: string): Command {
  const statements = parseQuery(text);
  expect(statements.length).toBe(1);
  return statements[0]!.command;
}

function errorOf(text: string): QuerySyntaxError {
  try {
    parseQuery(text);
  } catch (error) {
    if (error instanceof QuerySyntaxError) return error;
    throw error;
  }
  throw new Error(`Expected a syntax error for: ${text}`);
}

describe('find and chained calls', () => {
  test('parses filter, sort, skip and limit', () => {
    const command = one('db.users.find({name: "A", age: {$gt: 18}}).sort({age: -1}).skip(5).limit(10)');
    expect(command).toEqual({
      kind: 'find',
      collection: 'users',
      filter: { name: 'A', age: { $gt: 18 } },
      sort: { age: -1 },
      skip: 5,
      limit: 10,
    });
  });

  test('defaults filter to an empty object', () => {
    expect(one('db.users.find()')).toEqual({ kind: 'find', collection: 'users', filter: {} });
  });

  test('accepts relaxed syntax: unquoted and single-quoted keys, trailing commas, comments', () => {
    const text = `db.users.find(
      // filter comment
      { 'status': 'active', age: { $gte: 18, }, /* block */ tags: ["a", "b",], },
      { _id: 0, name: 1, },
    )`;
    expect(one(text)).toEqual({
      kind: 'find',
      collection: 'users',
      filter: { status: 'active', age: { $gte: 18 }, tags: ['a', 'b'] },
      projection: { _id: 0, name: 1 },
    });
  });

  test('keeps dotted collection names and getCollection', () => {
    expect(one('db.app.users.find({})')).toMatchObject({ kind: 'find', collection: 'app.users' });
    expect(one('db.getCollection("weird-name").find({})')).toMatchObject({ collection: 'weird-name' });
  });

  test('accepts toArray and NumberInt limits', () => {
    expect(one('db.users.find({}).limit(NumberInt(3)).toArray()')).toMatchObject({ limit: 3 });
  });

  test('rejects an unsupported chain call and duplicated chain calls', () => {
    expect(errorOf('db.users.find({}).explain()').message).toContain("'.explain()'");
    expect(errorOf('db.users.find({}).limit(1).limit(2)').message).toContain("'.limit()' bị lặp");
    expect(errorOf('db.users.insertOne({}).limit(1)').message).toContain("'.limit()'");
  });
});

describe('values and BSON constructors', () => {
  test('converts ObjectId, ISODate, new Date, NumberLong, NumberInt, NumberDecimal and UUID', () => {
    const command = one(
      `db.c.find({
        _id: ObjectId("64b7f0c2a1b2c3d4e5f60708"),
        at: ISODate("2024-01-02T03:04:05Z"),
        created: new Date("2024-01-02"),
        big: NumberLong("9007199254740993"),
        small: NumberInt(7),
        price: NumberDecimal("12.50"),
        uid: UUID("123e4567-e89b-12d3-a456-426614174000")
      })`,
    );
    expect(command).toMatchObject({
      kind: 'find',
      filter: {
        _id: { $oid: '64b7f0c2a1b2c3d4e5f60708' },
        at: { $date: '2024-01-02T03:04:05.000Z' },
        created: { $date: '2024-01-02T00:00:00.000Z' },
        big: { $numberLong: '9007199254740993' },
        small: { $numberInt: '7' },
        price: { $numberDecimal: '12.50' },
        uid: { $uuid: '123e4567-e89b-12d3-a456-426614174000' },
      },
    });
  });

  test('regex literal becomes a canonical regular expression', () => {
    expect(one('db.c.find({name: /^a\\/b[/]+/i})')).toMatchObject({
      filter: { name: { $regularExpression: { pattern: '^a\\/b[/]+', options: 'i' } } },
    });
  });

  test('numbers: hex, negative, exponent; literals true, false, null', () => {
    expect(one('db.c.find({a: 0x1F, b: -2.5, c: 1e3, d: true, e: false, f: null})')).toMatchObject({
      filter: { a: 31, b: -2.5, c: 1000, d: true, e: false, f: null },
    });
  });

  test('string escapes and both quote styles', () => {
    expect(one('db.c.find({a: "x\\ny", b: \'it\\\'s\', c: "\\u0041\\x42"})')).toMatchObject({
      filter: { a: 'x\ny', b: "it's", c: 'AB' },
    });
  });

  test('a key named __proto__ stays an ordinary own property', () => {
    const command = one('db.c.find({"__proto__": {"polluted": true}})') as { filter: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(command.filter, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('parseLiteral reads a single value and rejects trailing junk', () => {
    expect(parseLiteral('{ _id: ObjectId("64b7f0c2a1b2c3d4e5f60708") }')).toEqual({
      _id: { $oid: '64b7f0c2a1b2c3d4e5f60708' },
    });
    expect(() => parseLiteral('{a: 1} {b: 2}')).toThrow(QuerySyntaxError);
    expect(() => parseLiteral('   ')).toThrow(QuerySyntaxError);
  });
});

describe('other collection methods', () => {
  test('findOne, count, countDocuments and distinct', () => {
    expect(one('db.c.findOne({a: 1}, {b: 1})')).toEqual({
      kind: 'findOne', collection: 'c', filter: { a: 1 }, projection: { b: 1 },
    });
    expect(one('db.c.count()')).toEqual({ kind: 'count', collection: 'c', filter: {} });
    expect(one('db.c.countDocuments({x: 2})')).toEqual({ kind: 'count', collection: 'c', filter: { x: 2 } });
    expect(one('db.c.distinct("city", {active: true})')).toEqual({
      kind: 'distinct', collection: 'c', field: 'city', filter: { active: true },
    });
  });

  test('aggregate takes stages and whitelisted options', () => {
    const command = one('db.c.aggregate([{ $match: { a: 1 } }, { $group: { _id: "$a" } },], {allowDiskUse: true})');
    expect(command).toEqual({
      kind: 'aggregate',
      collection: 'c',
      stages: [{ $match: { a: 1 } }, { $group: { _id: '$a' } }],
      options: { allowDiskUse: true },
    });
    expect(errorOf('db.c.aggregate([], {collation: {}})').message).toContain("'collation'");
  });

  test('write methods build their command', () => {
    expect(one('db.c.insertOne({a: 1})')).toEqual({ kind: 'insertOne', collection: 'c', document: { a: 1 } });
    expect(one('db.c.insertMany([{a: 1}, {a: 2}])')).toEqual({
      kind: 'insertMany', collection: 'c', documents: [{ a: 1 }, { a: 2 }],
    });
    expect(one('db.c.updateMany({a: 1}, {$set: {b: 2}})')).toEqual({
      kind: 'updateMany', collection: 'c', filter: { a: 1 }, update: { $set: { b: 2 } },
    });
    expect(one('db.c.deleteMany({})')).toEqual({ kind: 'deleteMany', collection: 'c', filter: {} });
  });

  test('update without operators is rejected with a hint', () => {
    expect(errorOf('db.c.updateOne({a: 1}, {b: 2})').message).toContain('toán tử');
  });

  test('database-level commands', () => {
    expect(one('db.getCollectionNames()')).toEqual({ kind: 'collectionNames' });
    expect(one('db.stats()')).toEqual({ kind: 'stats' });
    expect(errorOf('db.stats(1)').message).toContain('không nhận tham số');
  });
});

describe('statements and cursor selection', () => {
  const text = 'db.a.find({}) ;\n\ndb.b.count();\ndb.c.insertOne({x: 1})';

  test('splits statements with start and end offsets', () => {
    const statements = parseQuery(text);
    expect(statements.map((s) => s.command.kind)).toEqual(['find', 'count', 'insertOne']);
    expect(text.slice(statements[1]!.start, statements[1]!.end)).toBe('db.b.count()');
  });

  test('picks the statement at or before the cursor, or the last one', () => {
    const statements = parseQuery(text);
    expect(pickStatement(statements, 3)).toBe(0);
    expect(pickStatement(statements, text.indexOf('count') + 2)).toBe(1);
    expect(pickStatement(statements, text.length)).toBe(2);
    expect(pickStatement(statements, null)).toBe(2);
    expect(pickStatement([], 0)).toBe(-1);
  });

  test('empty text and comment-only text give no statements', () => {
    expect(parseQuery('')).toEqual([]);
    expect(parseQuery('  // nothing here\n/* still nothing */')).toEqual([]);
  });

  test('marks writes, including aggregate with $out or $merge', () => {
    expect(isWriteCommand(one('db.c.deleteOne({})'))).toBe(true);
    expect(isWriteCommand(one('db.c.find({})'))).toBe(false);
    expect(isWriteCommand(one('db.c.aggregate([{$match: {}}, {$out: "copy"}])'))).toBe(true);
    expect(isWriteCommand(one('db.c.aggregate([{$match: {}}])'))).toBe(false);
  });
});

describe('syntax errors', () => {
  test('rejects functions that are not on the allow list', () => {
    const error = errorOf('db.c.find({ t: Math.random() })');
    expect(error.message).toContain('Giá trị không hợp lệ');
  });

  test('rejects unknown function calls with the list of supported ones', () => {
    const error = errorOf('db.c.find({ t: ObjectID("abc") })');
    expect(error.message).toContain("Không hỗ trợ hàm 'ObjectID()'");
    expect(error.message).toContain('ObjectId');
  });

  test('rejects $where with a JavaScript function and mapReduce', () => {
    expect(() => parseQuery('db.c.find({ $where: function() { return true; } })')).toThrow(QuerySyntaxError);
    expect(errorOf('db.c.mapReduce(m, r, {out: "x"})').message).toContain("'db.c.mapReduce()'");
  });

  test('rejects bare identifiers as values and unknown root objects', () => {
    expect(errorOf('db.c.find({a: b})').message).toContain("'b'");
    expect(errorOf('print("hi")').message).toContain("'db'");
  });

  test('rejects duplicated keys, unterminated strings and bad characters', () => {
    expect(errorOf('db.c.find({a: 1, a: 2})').message).toContain("Khoá 'a' bị lặp");
    expect(errorOf('db.c.find({a: "abc})').message).toContain('chưa đóng');
    expect(errorOf('db.c.find({a: 1 + 2})').message).toContain("'+'");
  });

  test('reports line and column of the error', () => {
    const error = errorOf('db.c.find({\n  a: 1,\n  b: oops\n})');
    expect(error.line).toBe(3);
    expect(error.column).toBe(6);
    expect(error.message).toContain('dòng 3, cột 6');
  });

  test('rejects BSON constructors with invalid arguments', () => {
    expect(() => parseQuery('db.c.find({_id: ObjectId("xyz")})')).toThrow(QuerySyntaxError);
    expect(() => parseQuery('db.c.find({at: ISODate("not a date")})')).toThrow(QuerySyntaxError);
    expect(() => parseQuery('db.c.find({n: NumberInt(1.5)})')).toThrow(QuerySyntaxError);
    expect(() => parseQuery('db.c.find({u: UUID("1234")})')).toThrow(QuerySyntaxError);
    expect(() => parseQuery('db.c.find({d: Date("2024")})')).toThrow("new Date");
  });

  test('requires a statement to start with db and end with a semicolon between statements', () => {
    expect(errorOf('users.find({})').message).toContain("'db'");
    expect(errorOf('db.a.find({}) db.b.find({})').message).toContain("';'");
  });
});
