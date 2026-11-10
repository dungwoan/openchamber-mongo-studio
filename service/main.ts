/**
 * Entry point của service Mongo Studio. OpenChamber chạy file này bằng Node và gọi qua
 * loopback 127.0.0.1 với bearer token; không bao giờ nhận kết nối từ mạng ngoài.
 */
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import { toHttpError, HttpError } from './errors.ts';
import { closeAll } from './pool.ts';
import { ROUTES } from './routes.ts';
import { warmAllConnections } from './mentions.ts';
import type { Body } from './validate.ts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SERVICE_NAME = 'mongo-studio';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

if (!Number.isInteger(port) || port <= 0 || token === '') {
  console.error('mongo-studio: thiếu OPENCHAMBER_SERVICE_PORT hoặc OPENCHAMBER_SERVICE_TOKEN');
  process.exit(1);
}

/** So sánh token theo thời gian hằng số để tránh đoán từng ký tự. */
function authorized(header: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'TOO_LARGE', 'Nội dung gửi lên quá lớn (tối đa 4 MB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(text: string): Body {
  if (text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'Nội dung gửi lên không phải JSON hợp lệ');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'BAD_JSON', 'Nội dung gửi lên phải là một đối tượng JSON');
  }
  return value as Body;
}

async function dispatch(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
  if (path === '/health') {
    send(res, req.method === 'GET' ? 200 : 405, req.method === 'GET' ? { ok: true, service: SERVICE_NAME } : { error: 'Dùng GET cho /health', code: 'METHOD' });
    return;
  }
  const handler = ROUTES[path];
  if (!handler) {
    send(res, 404, { error: `Không có route ${path}`, code: 'NOT_FOUND' });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'Route này chỉ nhận POST với body JSON', code: 'METHOD' });
    return;
  }
  const result = await handler(parseBody(await readBody(req)));
  send(res, 200, result ?? { ok: true });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authorized(req.headers.authorization)) {
    send(res, 401, { error: 'Thiếu hoặc sai token', code: 'UNAUTHORIZED' });
    return;
  }
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  try {
    await dispatch(req, res, path);
  } catch (error) {
    const mapped = toHttpError(error);
    if (mapped.status === 500) console.error(`mongo-studio: lỗi ở ${path} (${error instanceof Error ? error.name : 'unknown'})`);
    send(res, mapped.status, mapped.toBody());
  }
}

const server = http.createServer((req, res) => {
  void handle(req, res);
});

server.listen(port, '127.0.0.1', () => {
  warmAllConnections();
});

/** Đóng server và các client MongoDB rồi thoát; OpenChamber gửi SIGTERM khi dừng service. */
async function shutdown(): Promise<void> {
  server.close();
  await closeAll();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
