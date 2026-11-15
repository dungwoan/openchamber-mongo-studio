/**
 * Route sơ đồ database. Service chỉ đọc mã nguồn và các file báo cáo trong .openchamber/mongo-studio/ của dự án.
 * - schema-scan.json: do service ghi khi người dùng bật "Ghi báo cáo vào dự án".
 * - schema-report.json: do agent ghi theo yêu cầu; service chỉ đọc và kiểm tra bằng validateReport.
 * Không bao giờ ghi .gitignore của dự án: chỉ gợi ý.
 */
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DiagramAgentResponse, DiagramGetResponse, DiagramScanResponse, SchemaReport } from '../../shared/api.ts';
import { analyze } from '../detectors/index.ts';
import { HttpError } from '../errors.ts';
import { combineReports, emptyReport, LIMITS, validateReport } from '../schema-report.ts';
import { collectFiles } from '../schema-scan.ts';
import { isInside, type ProjectDir, resolveProjectDir } from '../project-files.ts';
import { type Body, optionalBoolean } from '../validate.ts';

const REPORT_DIR = ['.openchamber', 'mongo-studio'] as const;
export const AGENT_REPORT_FILE = 'schema-report.json';
export const SCAN_REPORT_FILE = 'schema-scan.json';

/** Báo cáo quét tĩnh gần nhất theo thư mục dự án (trong bộ nhớ, không ghi đĩa trừ khi bật ghi). */
const scans = new Map<string, SchemaReport>();

/** Quét mã nguồn và trả về báo cáo đã kiểm tra (nguồn "static"). */
async function scanStatic(dir: ProjectDir): Promise<SchemaReport> {
  const scan = await collectFiles(dir);
  const raw = analyze(scan.files, { truncated: scan.truncated, warnings: scan.warnings });
  const { report, warnings } = validateReport(raw, 'static');
  const result = report ?? emptyReport('static', warnings);
  scans.set(dir.key, result);
  return result;
}

/**
 * Đi từng thành phần của đường dẫn trong dự án; mọi thành phần phải là thư mục thật (không symlink).
 *
 * Returns:
 *   Đường dẫn tuyệt đối của thư mục, hoặc null nếu thiếu và create = false.
 *
 * Raises:
 *   HttpError 400 khi một thành phần là symlink hoặc không phải thư mục.
 */
async function reportFolder(dir: ProjectDir, create: boolean): Promise<string | null> {
  let current = dir.real;
  for (const part of REPORT_DIR) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch {
      if (!create) return null;
      await mkdir(current, { mode: 0o755 });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new HttpError(400, 'UNSAFE_PATH', 'Không thể ghi báo cáo: .openchamber/mongo-studio trong dự án là symlink hoặc không phải thư mục, nên không ghi được báo cáo. Xoá hoặc đổi tên mục đó rồi thử lại.');
    }
  }
  return current;
}

/** Ghi file báo cáo vào .openchamber/mongo-studio (ghi tạm rồi đổi tên). Trả về đường dẫn tương đối. */
async function writeReport(dir: ProjectDir, fileName: string, text: string): Promise<string> {
  const folder = await reportFolder(dir, true) as string;
  const target = path.join(folder, fileName);
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new HttpError(400, 'UNSAFE_PATH', `${fileName} là symlink, không ghi đè.`);
  }
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, text, { mode: 0o644 });
  await rename(temp, target);
  return [...REPORT_DIR, fileName].join('/');
}

/** Đọc và kiểm tra báo cáo của agent; mọi lỗi chỉ thành cảnh báo, không làm hỏng sơ đồ. */
async function readAgentReport(dir: ProjectDir): Promise<{ report: SchemaReport | null; warnings: string[] }> {
  try {
    const folder = await reportFolder(dir, false);
    if (folder === null) return { report: null, warnings: [] };
    const file = path.join(folder, AGENT_REPORT_FILE);
    const info = await lstat(file).catch(() => null);
    if (info === null) return { report: null, warnings: [] };
    if (info.isSymbolicLink() || !info.isFile()) return { report: null, warnings: ['schema-report.json không phải file thường, bỏ qua'] };
    if (info.size > LIMITS.bytes) return { report: null, warnings: ['schema-report.json quá lớn, bỏ qua'] };
    const real = await realpath(file);
    if (!isInside(dir.real, real)) return { report: null, warnings: ['schema-report.json nằm ngoài dự án, bỏ qua'] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(real, 'utf8'));
    } catch {
      return { report: null, warnings: ['schema-report.json không phải JSON hợp lệ, bỏ qua'] };
    }
    return validateReport(parsed, 'agent');
  } catch (error) {
    if (error instanceof HttpError) return { report: null, warnings: [error.message] };
    throw error;
  }
}

/** Trạng thái .gitignore của dự án, chỉ để gợi ý; không bao giờ sửa file này. */
async function gitignoreState(dir: ProjectDir): Promise<DiagramScanResponse['gitignore']> {
  const text = await readFile(path.join(dir.real, '.gitignore'), 'utf8').catch(() => null);
  if (text === null) return 'absent';
  const ignored = text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === '.openchamber/' || trimmed === '.openchamber';
  });
  return ignored ? 'present' : 'missing';
}

/** Route /diagram/scan: quét lại; ghi schema-scan.json khi body.write là true. */
export async function scanRoute(body: Body): Promise<DiagramScanResponse> {
  const dir = await resolveProjectDir(body.directory);
  const report = await scanStatic(dir);
  const write = optionalBoolean(body, 'write', false);
  const written = write ? await writeReport(dir, SCAN_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`) : null;
  return { report, written, gitignore: await gitignoreState(dir) };
}

/** Route /diagram/get: báo cáo tĩnh (quét nếu chưa có) gộp với báo cáo của agent. */
export async function getRoute(body: Body): Promise<DiagramGetResponse> {
  const dir = await resolveProjectDir(body.directory);
  const base = scans.get(dir.key) ?? await scanStatic(dir);
  const agent = await readAgentReport(dir);
  const combined = combineReports(base, agent.report);
  const warnings = [...new Set([...combined.warnings, ...agent.warnings])].slice(0, LIMITS.warnings);
  return { report: { ...combined, warnings }, hasAgentReport: agent.report !== null };
}

/** Route /diagram/agent-report: báo cáo của agent đã kiểm tra, hoặc null kèm cảnh báo. */
export async function agentReportRoute(body: Body): Promise<DiagramAgentResponse> {
  const dir = await resolveProjectDir(body.directory);
  return readAgentReport(dir);
}
