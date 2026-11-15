import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseCompose, parseDotenv } from './env-file.ts';
import { detectedId, registerDetected } from './detected.ts';
import { detectProjectUri, isInside, pickUri, resolveProjectDir } from './project-files.ts';
import {
  pickSource,
  sanitizeMemory,
  withAutoDisabled,
  withDetected,
  withSelection,
  type ProjectMemory,
} from './project-memory.ts';
import { changeProjects, listProjects } from './store.ts';
import { toHttpError } from './errors.ts';
import { databaseOf } from './uri.ts';

const GOOD = 'mongodb://app:secret@db1.local:27017/shop?authSource=admin';

let sandbox = '';
let fakeHome = '';

beforeAll(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'ms-unit-'));
  fakeHome = path.join(sandbox, 'home');
  await mkdir(fakeHome, { recursive: true });
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/** Chạy store-probe trong process con có HOME tạm, rồi đọc báo cáo JSON. */
function runStoreProbe(): Record<string, unknown> {
  const run = Bun.spawnSync([process.execPath, path.join(import.meta.dir, 'store-probe.ts')], {
    env: { ...process.env, HOME: fakeHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString().trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
}

/** Tạo một thư mục dự án mới trong sandbox và trả về đường dẫn của nó. */
async function project(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(sandbox, 'projects', name);
  await mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(dir, file), text);
  return dir;
}

describe('parseDotenv', () => {
  test('đọc nháy đơn, nháy kép, export, khoảng trắng và comment', () => {
    const entries = parseDotenv([
      '# comment',
      'export MONGO_URI="mongodb://a:b@h:1/x"',
      "  MONGODB_URL = 'mongodb://c@h2:2/y'  ",
      'PLAIN=value # trailing comment',
      'HASH_ONLY=#nothing',
      '',
    ].join('\n'));
    expect(entries).toEqual([
      { key: 'MONGO_URI', value: 'mongodb://a:b@h:1/x' },
      { key: 'MONGODB_URL', value: 'mongodb://c@h2:2/y' },
      { key: 'PLAIN', value: 'value' },
      { key: 'HASH_ONLY', value: '' },
    ]);
  });

  test('bỏ qua dòng thiếu dấu =, khoá sai và nháy không đóng', () => {
    const entries = parseDotenv(['NO_EQUALS', '1BAD=x', 'OPEN="never closed', 'OK=1'].join('\n'));
    expect(entries).toEqual([{ key: 'OK', value: '1' }]);
  });

  test('xử lý escape trong nháy kép và BOM đầu file', () => {
    const entries = parseDotenv('\uFEFFA="say \\"hi\\"\\n"\nB=\'raw \\n\'');
    expect(entries).toEqual([
      { key: 'A', value: 'say "hi"\n' },
      { key: 'B', value: 'raw \\n' },
    ]);
  });

  test('giữ nguyên giá trị postgres (việc loại bỏ nằm ở pickUri)', () => {
    expect(parseDotenv('DATABASE_URL=postgres://u:p@h/db')).toEqual([{ key: 'DATABASE_URL', value: 'postgres://u:p@h/db' }]);
  });
});

describe('parseCompose', () => {
  test('đọc cả dạng map và dạng list của environment', () => {
    const entries = parseCompose([
      'services:',
      '  api:',
      '    environment:',
      `      MONGO_URI: "${GOOD}"`,
      '    # MONGODB_URI: mongodb://commented',
      '  worker:',
      '    environment:',
      '      - MONGODB_DSN=${MONGODB_DSN}',
      '      - DATABASE_URL=postgres://u:p@h/db',
    ].join('\n'));
    expect(entries).toContainEqual({ key: 'MONGO_URI', value: GOOD });
    expect(entries).toContainEqual({ key: 'MONGODB_DSN', value: '${MONGODB_DSN}' });
    expect(entries.some((entry) => entry.key === 'MONGODB_URI')).toBe(false);
  });
});

describe('pickUri', () => {
  test('ưu tiên file theo thứ tự và biến theo thứ tự URI_KEYS', () => {
    const result = pickUri([
      { name: '.env', text: `DATABASE_URL=${GOOD}\nMONGO_URI=mongodb://first@h/a` },
      { name: 'compose.yml', text: `MONGODB_URI: ${GOOD}` },
    ]);
    expect(result).toEqual({ kind: 'found', uri: 'mongodb://first@h/a', sourceFile: '.env', key: 'MONGO_URI' });
  });

  test('tên biến không phân biệt hoa thường và dòng sau ghi đè dòng trước', () => {
    const result = pickUri([{ name: '.env', text: 'mongo_uri=mongodb://old@h/a\nMONGO_URI=mongodb://new@h/b' }]);
    expect(result).toMatchObject({ kind: 'found', uri: 'mongodb://new@h/b' });
  });

  test('bỏ qua postgres và URI sai khi còn URI đúng', () => {
    const result = pickUri([{ name: '.env', text: `DATABASE_URL=postgres://u@h/db\nMONGODB_URI=mongodb://\nMONGO_URI=${GOOD}` }]);
    expect(result).toMatchObject({ kind: 'found', key: 'MONGO_URI' });
  });

  test('chỉ có URI sai thì báo invalid, thông báo không chứa URI', () => {
    const result = pickUri([{ name: '.env', text: 'MONGODB_URI=mongodb://app:secret@/' }]);
    expect(result?.kind).toBe('invalid');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('không có gì dùng được thì trả về null', () => {
    expect(pickUri([{ name: '.env', text: 'DATABASE_URL=postgres://u@h/db' }])).toBeNull();
    expect(pickUri([])).toBeNull();
  });
});

describe('resolveProjectDir', () => {
  test('chặn đường dẫn tương đối, có "..", có NUL, không tồn tại và không phải thư mục', async () => {
    const dir = await project('guard-basic', { 'file.txt': 'x' });
    const bad: unknown[] = [
      'relative/path',
      `${dir}/../other`,
      `${dir}\0`,
      '',
      42,
      path.join(sandbox, 'does-not-exist'),
      path.join(dir, 'file.txt'),
    ];
    for (const input of bad) {
      await expect(resolveProjectDir(input)).rejects.toMatchObject({ status: 400, code: 'BAD_DIRECTORY' });
    }
  });

  test('nhận thư mục tuyệt đối có thật', async () => {
    const dir = await project('guard-ok', {});
    const resolved = await resolveProjectDir(dir);
    expect(resolved.key).toBe(dir);
    expect(resolved.real).toBe(await realpath(dir));
  });
});

describe('detectProjectUri (đường dẫn và file)', () => {
  test('chỉ đọc đúng allowlist: .env.production không được đọc', async () => {
    const dir = await project('allowlist', { '.env.production': `MONGO_URI=${GOOD}` });
    const dirInfo = await resolveProjectDir(dir);
    expect(await detectProjectUri(dirInfo)).toBeNull();
  });

  test('tìm thấy trong .env của đúng thư mục dự án', async () => {
    const dir = await project('plain', { '.env': `MONGO_URI="${GOOD}"` });
    expect(await detectProjectUri(await resolveProjectDir(dir))).toEqual({
      kind: 'found',
      uri: GOOD,
      sourceFile: '.env',
      key: 'MONGO_URI',
    });
  });

  test('symlink .env trỏ ra ngoài thư mục dự án bị bỏ qua', async () => {
    const outside = path.join(sandbox, 'outside.env');
    await writeFile(outside, `MONGO_URI=${GOOD}`);
    const dir = await project('escape', {});
    await symlink(outside, path.join(dir, '.env'));
    expect(await detectProjectUri(await resolveProjectDir(dir))).toBeNull();
  });

  test('symlink nằm trong thư mục dự án vẫn được đọc', async () => {
    const dir = await project('inside-link', { 'real.env': `MONGODB_URI=${GOOD}` });
    await symlink(path.join(dir, 'real.env'), path.join(dir, '.env'));
    expect(await detectProjectUri(await resolveProjectDir(dir))).toMatchObject({ kind: 'found', sourceFile: '.env' });
  });

  test('không đọc .env của thư mục cha', async () => {
    const parent = await project('parent-has-env', { '.env': `MONGO_URI=${GOOD}` });
    const child = path.join(parent, 'child');
    await mkdir(child);
    expect(await detectProjectUri(await resolveProjectDir(child))).toBeNull();
  });

  test('isInside: chính root và con là trong, tiền tố giống nhau thì không', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
  });
});

describe('databaseOf và hosts', () => {
  test('lấy tên database, bỏ query và thông tin đăng nhập', () => {
    expect(databaseOf(GOOD)).toBe('shop');
    expect(databaseOf('mongodb+srv://u:p@cluster.example.net/?retryWrites=true')).toBe('');
    expect(databaseOf('mongodb://h:27017')).toBe('');
    expect(databaseOf('mongodb://h/my%20db')).toBe('my db');
  });
});

describe('quyết định nguồn kết nối (priority và autoDisabled)', () => {
  test('đã ngắt tự động thì không nối gì, kể cả connection đã nhớ', () => {
    expect(pickSource({ connectionId: 'c1', autoDisabled: true }, true)).toBe('disabled');
    expect(pickSource({ autoDisabled: true }, false)).toBe('disabled');
  });

  test('connection đã nhớ còn tồn tại thì ưu tiên hơn file cấu hình', () => {
    expect(pickSource({ connectionId: 'c1', detected: true }, true)).toBe('remembered');
  });

  test('connection đã nhớ đã bị xoá thì quay về quét file', () => {
    expect(pickSource({ connectionId: 'gone' }, false)).toBe('scan');
    expect(pickSource({}, false)).toBe('scan');
  });

  test('bật/tắt cờ giữ connectionId; chọn lại connection xoá cờ đã ngắt', () => {
    const memory: ProjectMemory = { connectionId: 'c1' };
    const off = withAutoDisabled(memory, true);
    expect(off).toEqual({ connectionId: 'c1', autoDisabled: true });
    expect(withAutoDisabled(off, false)).toEqual({ connectionId: 'c1' });
    expect(withSelection(off, { kind: 'saved', id: 'c2' })).toEqual({ connectionId: 'c2' });
  });

  test('chọn cấu hình của dự án xoá connectionId đã nhớ và đánh dấu detected', () => {
    expect(withSelection({ connectionId: 'c1', autoDisabled: true }, { kind: 'detected' })).toEqual({ detected: true });
    expect(withDetected({})).toEqual({ detected: true });
  });

  test('sanitizeMemory bỏ trường sai kiểu và giá trị không phải đối tượng', () => {
    expect(sanitizeMemory({ connectionId: 5, autoDisabled: 'yes', detected: true })).toEqual({ detected: true });
    expect(sanitizeMemory(['x'])).toBeNull();
    expect(sanitizeMemory(null)).toBeNull();
  });
});

describe('registry connection phát hiện', () => {
  test('id ổn định theo dự án và file', () => {
    const projectKey = path.join(sandbox, 'registry-proj');
    expect(detectedId(projectKey, '.env')).toBe(detectedId(projectKey, '.env'));
    expect(detectedId(projectKey, '.env')).not.toBe(detectedId(projectKey, 'compose.yml'));
    expect(detectedId(projectKey, '.env')).toMatch(/^auto-[0-9a-f]{32}$/);

    const record = registerDetected(projectKey, { kind: 'found', uri: GOOD, sourceFile: '.env', key: 'MONGO_URI' });
    expect(record.readOnly).toBe(true);
    expect(record.name).toBe('registry-proj · .env');
  });
});

describe('projects.json (chạy trong process con với HOME tạm)', () => {
  test('ghi đúng quyền 0600 trong thư mục 0700, không ghi lại khi không đổi, đọc lại được', () => {
    const report = runStoreProbe();
    expect(report.fileMode).toBe(0o600);
    expect(report.dirMode).toBe(0o700);
    expect(report.unchangedSkipsWrite).toBe(true);
    expect(report.listed).toEqual({ connectionId: 'c1' });
  });

  test('file hỏng chỉ làm mất bản nhớ, không làm lỗi; lần ghi sau thay file hỏng', () => {
    const report = runStoreProbe();
    expect(report.corruptListed).toEqual({});
    expect(report.rewritten).toEqual({ version: 1, projects: { '/x': { detected: true } } });
  });

  test('đăng ký connection phát hiện không tạo connections.json', () => {
    expect(runStoreProbe().connectionsFileCreated).toBe(false);
  });
});

/** Tạo file kèm thư mục cha (cho phép đường dẫn con như backend/.env). */
async function tree(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(sandbox, 'tree', name);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('quét một cấp thư mục con', () => {
  test('chỉ có backend/.env thì phát hiện được, sourceFile là đường dẫn con', async () => {
    const dir = await tree('sub-only', { 'backend/.env': `MONGODB_URI=${GOOD}` });
    expect(await detectProjectUri(await resolveProjectDir(dir))).toMatchObject({ kind: 'found', sourceFile: 'backend/.env' });
  });

  test('gốc thắng con: .env ở gốc (URI đúng) được dùng dù con cũng có URI', async () => {
    const dir = await tree('root-wins', { '.env': `MONGO_URI=${GOOD}`, 'backend/.env': `MONGO_URI=mongodb://sub@127.0.0.1:2/x` });
    expect(await detectProjectUri(await resolveProjectDir(dir))).toMatchObject({ kind: 'found', sourceFile: '.env', uri: GOOD });
  });

  test('gốc có URI sai thì con có URI đúng vẫn được dùng', async () => {
    const dir = await tree('root-invalid', { '.env': 'MONGO_URI=mongodb://\n', 'backend/.env': `MONGO_URI=${GOOD}` });
    expect(await detectProjectUri(await resolveProjectDir(dir))).toMatchObject({ kind: 'found', sourceFile: 'backend/.env' });
  });

  test('trong cùng cấp: thứ tự thư mục theo tên, rồi thứ tự allowlist trong từng thư mục', async () => {
    const dir = await tree('order', {
      'api/.env': `MONGO_URI=${GOOD}`,
      'worker/.env': `MONGO_URI=mongodb://worker@127.0.0.1:3/x`,
    });
    expect(await detectProjectUri(await resolveProjectDir(dir))).toMatchObject({ kind: 'found', sourceFile: 'api/.env' });
  });

  test('bỏ qua ẩn, node_modules, vendor, dist, build, .git, venv, .venv, venv* và *.egg-info', async () => {
    const skipped = ['.hidden', 'node_modules', 'vendor', 'dist', 'build', '.git', 'venv', '.venv', 'venv311', 'pkg.egg-info'];
    const dir = await tree('skipped', Object.fromEntries(skipped.map((d) => [`${d}/.env`, `MONGO_URI=${GOOD}`])));
    expect(await detectProjectUri(await resolveProjectDir(dir))).toBeNull();
  });

  test('không quét cháu (cấp hai): a/b/.env không được phát hiện', async () => {
    const dir = await tree('depth2', { 'a/b/.env': `MONGO_URI=${GOOD}` });
    expect(await detectProjectUri(await resolveProjectDir(dir))).toBeNull();
  });

  test('quá 100 thư mục con thì không quét cấp con (dừng ở gốc)', async () => {
    const files: Record<string, string> = { 'zzz/.env': `MONGO_URI=${GOOD}` };
    for (let i = 0; i < 100; i += 1) files[`d${String(i).padStart(3, '0')}/README.md`] = 'x';
    const dir = await tree('too-many', files);
    expect(await detectProjectUri(await resolveProjectDir(dir))).toBeNull();
  });

  test('thư mục con là symlink trỏ ra ngoài không được quét', async () => {
    const outside = path.join(sandbox, 'outside-dir');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, '.env'), `MONGO_URI=${GOOD}`);
    const dir = await tree('link-dir', {});
    await symlink(outside, path.join(dir, 'linked'));
    expect(await detectProjectUri(await resolveProjectDir(dir))).toBeNull();
  });

  test('file .env con là symlink trỏ ra ngoài bị bỏ qua', async () => {
    const outside = path.join(sandbox, 'outside.env2');
    await writeFile(outside, `MONGO_URI=${GOOD}`);
    const dir = await tree('link-file', { 'backend/.keep': '' });
    await symlink(outside, path.join(dir, 'backend', '.env'));
    expect(await detectProjectUri(await resolveProjectDir(dir))).toBeNull();
  });
});

describe('lỗi host không phân giải được (DNS)', () => {
  const dnsError = (code: string) => ({
    name: 'MongoServerSelectionError',
    message: `getaddrinfo ${code} mongo`,
    cause: { name: 'DNSException', code, message: `getaddrinfo ${code} mongo` },
  });

  test('EAI_AGAIN → UNRESOLVABLE_HOST với tên host, không có URI', () => {
    const mapped = toHttpError(dnsError('EAI_AGAIN'), 'mongodb://tester:TESTPW-7vq2x9@mongo:27017/shop?authSource=admin', 'connect');
    expect(mapped.status).toBe(424);
    expect(mapped.code).toBe('UNRESOLVABLE_HOST');
    expect(mapped.message).toBe('Không phân giải được host "mongo" từ máy này (có thể là tên nội bộ Docker). Dùng connection cổng public nếu có, hoặc thêm connection thủ công với URI dùng được.');
  });

  test('ENOTFOUND cũng được nhận diện', () => {
    const mapped = toHttpError(dnsError('ENOTFOUND'), 'mongodb://tester:TESTPW@mongo:27017/shop', 'connect');
    expect(mapped.code).toBe('UNRESOLVABLE_HOST');
    expect(mapped.message).not.toContain('TESTPW');
  });

  test('host không phải DNS (cổng đóng) vẫn là UNREACHABLE', () => {
    const refused = { name: 'MongoServerSelectionError', message: 'connect ECONNREFUSED 127.0.0.1:1' };
    expect(toHttpError(refused, 'mongodb://127.0.0.1:1/x', 'connect').code).toBe('UNREACHABLE');
  });

  test('lỗi DNS khi truy vấn (context query) không đổi thành thông báo host', () => {
    expect(toHttpError(dnsError('EAI_AGAIN'), 'mongodb://mongo:27017', 'query').code).not.toBe('UNRESOLVABLE_HOST');
  });
});
