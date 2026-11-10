/**
 * Route chạy query trong editor và lịch sử query.
 */
import type { HistoryResponse, QueryResponse } from '../../shared/api.ts';
import { isWriteCommand, parseQuery, pickStatement } from '../../shared/query-parser.ts';
import { fitToBudget } from '../ejson.ts';
import { badRequest, HttpError } from '../errors.ts';
import { withDatabase } from '../pool.ts';
import { executeCommand } from '../query-exec.ts';
import { addHistory, listConnections, listHistory } from '../store.ts';
import { type Body, optionalBoolean, optionalInteger, optionalString, requireString } from '../validate.ts';
import { assertWritable, connectionFrom, RESPONSE_BUDGET } from './common.ts';

/**
 * Route /query/run: parse toàn bộ editor, chạy lệnh tại con trỏ (hoặc lệnh cuối nếu không có con trỏ).
 * Lệnh ghi trên connection thường cần confirmWrite=true, nếu không sẽ trả 409 CONFIRM_REQUIRED.
 */
export async function runRoute(body: Body): Promise<QueryResponse> {
  const record = await connectionFrom(body);
  const database = requireString(body, 'database', 255);
  const text = optionalString(body, 'text', 200_000) ?? '';
  const cursor = optionalInteger(body, 'cursor', 0, 10_000_000) ?? null;
  const confirmWrite = optionalBoolean(body, 'confirmWrite', false);

  const statements = parseQuery(text);
  if (statements.length === 0) throw badRequest('Chưa có lệnh nào. Ví dụ: db.users.find({}).limit(10)');
  const index = pickStatement(statements, cursor);
  const statement = statements[index];
  if (!statement) throw badRequest('Không xác định được lệnh cần chạy');

  const write = isWriteCommand(statement.command);
  if (write) assertWritable(record);
  if (write && !confirmWrite) {
    throw new HttpError(409, 'CONFIRM_REQUIRED', `Lệnh ghi "${statement.command.kind}" sẽ thay đổi dữ liệu. Xác nhận để chạy.`);
  }

  const started = Date.now();
  const outcome = await withDatabase(record, database, (db) => executeCommand(db, statement.command));
  const elapsedMs = Date.now() - started;

  await addHistory({
    text: text.slice(statement.start, statement.end),
    connectionId: record.id,
    database,
    at: Date.now(),
  }).catch(() => undefined);

  const fitted = Array.isArray(outcome.result) ? fitToBudget(outcome.result, RESPONSE_BUDGET) : null;
  return {
    kind: outcome.kind,
    result: fitted ? fitted.items : outcome.result,
    count: fitted ? fitted.items.length : outcome.count,
    truncated: outcome.truncated || (fitted?.truncated ?? false),
    elapsedMs,
    statement: { start: statement.start, end: statement.end, index, total: statements.length },
    isWrite: write,
  };
}

/** Route /query/history: lịch sử mới nhất trước. */
export async function historyRoute(): Promise<HistoryResponse> {
  return { entries: await listHistory() };
}

/** Route /query/history/add: lưu một câu lệnh vào lịch sử (dùng khi page muốn ghi lại thủ công). */
export async function historyAddRoute(body: Body): Promise<{ ok: true }> {
  const text = requireString(body, 'text', 20_000);
  const connectionId = requireString(body, 'connectionId', 64);
  const database = requireString(body, 'database', 255);
  const exists = (await listConnections()).some((record) => record.id === connectionId);
  if (!exists) throw badRequest('Connection không còn tồn tại');
  await addHistory({ text, connectionId, database, at: Date.now() });
  return { ok: true };
}
