/**
 * Route tự kết nối theo dự án. Panel chỉ nhận host, port (nằm trong host), db, tên và nguồn;
 * URI và mật khẩu ở lại trong service.
 */
import type {
  ConnectionView,
  OkResponse,
  ProjectConnectResponse,
  ProjectConnectionView,
} from '../../shared/api.ts';
import { detectedId, type DetectedRecord, registerDetected } from '../detected.ts';
import { HttpError, notFound, toHttpError } from '../errors.ts';
import { clientFor, closeConnection, isConnected } from '../pool.ts';
import { type Detection, detectProjectUri, type ProjectDir, resolveProjectDir } from '../project-files.ts';
import {
  pickSource,
  type ProjectMemory,
  type Selection,
  withAutoDisabled,
  withDetected,
  withSelection,
} from '../project-memory.ts';
import { changeProjects, type ConnectionRecord, listConnections, listProjects } from '../store.ts';
import { databaseOf, hostsOf } from '../uri.ts';
import { type Body, requireString } from '../validate.ts';

type Source = 'remembered' | 'project-file';

const NONE: ProjectConnectResponse = { status: 'none' };

/** Thông tin an toàn của connection gửi cho panel: không có URI, không có mật khẩu. */
function infoOf(record: ConnectionRecord, source: Source): ProjectConnectionView {
  const sourceFile = (record as Partial<DetectedRecord>).sourceFile;
  return {
    id: record.id,
    name: record.name,
    host: hostsOf(record.uri),
    db: databaseOf(record.uri),
    source,
    ...(sourceFile ? { sourceFile } : {}),
  };
}

/** Mở kết nối và ping; lỗi được đổi thành thông báo đã che URI. */
async function connectTo(record: ConnectionRecord, source: Source): Promise<ProjectConnectResponse> {
  try {
    await clientFor(record);
  } catch (error) {
    const mapped = toHttpError(error, record.uri, 'connect');
    const sourceFile = (record as Partial<DetectedRecord>).sourceFile;
    return {
      status: 'error',
      source,
      name: record.name,
      ...(sourceFile ? { sourceFile } : {}),
      code: mapped.code,
      error: mapped.message,
    };
  }
  return { status: 'connected', connection: infoOf(record, source) };
}

/** Kết quả quét file: URI đúng thì nối; URI sai thì báo để người dùng sửa. */
async function scanAndConnect(dir: ProjectDir, memory: ProjectMemory): Promise<ProjectConnectResponse> {
  const found: Detection | null = await detectProjectUri(dir);
  if (found === null) return NONE;
  if (found.kind === 'invalid') {
    return { status: 'error', source: 'project-file', sourceFile: found.sourceFile, code: 'INVALID_URI', error: found.problem };
  }
  const record = registerDetected(dir.key, found);
  const reply = await connectTo(record, 'project-file');
  if (reply.status === 'connected' && memory.detected !== true) {
    await changeProjects((map) => ({ map: { ...map, [dir.key]: withDetected(map[dir.key] ?? {}) }, result: undefined }));
  }
  return reply;
}

/** Route /project/open: nối connection đã nhớ, hoặc quét file cấu hình của dự án. */
export async function openRoute(body: Body): Promise<ProjectConnectResponse> {
  const dir = await resolveProjectDir(body.directory);
  const memory = (await listProjects())[dir.key] ?? {};
  const saved = memory.connectionId === undefined
    ? undefined
    : (await listConnections()).find((item) => item.id === memory.connectionId);
  const plan = pickSource(memory, saved !== undefined);
  if (plan === 'disabled') return NONE;
  if (plan === 'remembered' && saved) return connectTo(saved, 'remembered');
  return scanAndConnect(dir, memory);
}

/** Route /project/disconnect: đóng kết nối tự động và ghi cờ để lần mở sau không tự nối. */
export async function disconnectRoute(body: Body): Promise<OkResponse> {
  const dir = await resolveProjectDir(body.directory);
  const memory = (await listProjects())[dir.key] ?? {};
  if (memory.connectionId !== undefined) await closeConnection(memory.connectionId);
  const found = await detectProjectUri(dir);
  if (found?.kind === 'found') await closeConnection(detectedId(dir.key, found.sourceFile));
  await changeProjects((map) => ({
    map: { ...map, [dir.key]: withAutoDisabled(map[dir.key] ?? {}, true) },
    result: undefined,
  }));
  return { ok: true };
}

/** Xác định người dùng đang chọn connection đã lưu hay cấu hình của dự án; sai id thì 404. */
async function selectionOf(dir: ProjectDir, connectionId: string): Promise<Selection> {
  if ((await listConnections()).some((item) => item.id === connectionId)) return { kind: 'saved', id: connectionId };
  const found = await detectProjectUri(dir);
  if (found?.kind === 'found' && detectedId(dir.key, found.sourceFile) === connectionId) {
    registerDetected(dir.key, found);
    return { kind: 'detected' };
  }
  throw notFound('This connection is no longer in the project. Reload the list and try again.');
}

/** Route /project/select: ghi nhớ connection người dùng vừa chọn; chọn lại thì xoá cờ đã ngắt. */
export async function selectRoute(body: Body): Promise<OkResponse> {
  const dir = await resolveProjectDir(body.directory);
  const connectionId = requireString(body, 'connectionId', 64);
  const selection = await selectionOf(dir, connectionId);
  await changeProjects((map) => ({
    map: { ...map, [dir.key]: withSelection(map[dir.key] ?? {}, selection) },
    result: undefined,
  }));
  return { ok: true };
}

/**
 * Connection phát hiện của dự án, để hiện trong danh sách (kể cả khi đã ngắt, để người dùng chọn lại).
 * Thư mục không còn hợp lệ thì trả về null: danh sách vẫn tải được.
 *
 * Args:
 *   input: Giá trị directory trong body của /connections/list.
 *
 * Returns:
 *   Dòng hiển thị của connection phát hiện, hoặc null.
 */
export async function detectedListing(input: unknown): Promise<ConnectionView | null> {
  let dir: ProjectDir;
  try {
    dir = await resolveProjectDir(input);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'BAD_DIRECTORY') return null;
    throw error;
  }
  const found = await detectProjectUri(dir);
  if (found?.kind !== 'found') return null;
  const record = registerDetected(dir.key, found);
  return {
    id: record.id,
    name: record.name,
    hosts: hostsOf(record.uri),
    readOnly: record.readOnly,
    connected: isConnected(record.id),
    source: 'project-file',
    sourceFile: record.sourceFile,
  };
}
