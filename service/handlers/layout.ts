/**
 * Route vị trí sơ đồ: đọc và ghi .openchamber/mongo-studio/layout.json trong dự án. Không ghi gì khác.
 * "Sắp xếp lại" ghi positions rỗng (file vẫn tồn tại).
 */
import type { DiagramLayoutGetResponse, DiagramLayoutSaveResponse } from '../../shared/api.ts';
import { readProjectFile, writeReport } from './diagram.ts';
import { HttpError } from '../errors.ts';
import { resolveProjectDir } from '../project-files.ts';
import { LAYOUT_FILE, MAX_LAYOUT_BYTES, validateLayout } from '../layout.ts';
import type { Body } from '../validate.ts';

/** Route /diagram/layout/get: vị trí đã lưu, hoặc rỗng nếu chưa có hoặc file không hợp lệ. */
export async function layoutGetRoute(body: Body): Promise<DiagramLayoutGetResponse> {
  const dir = await resolveProjectDir(body.directory);
  const text = await readProjectFile(dir, LAYOUT_FILE, MAX_LAYOUT_BYTES);
  if (text === null) return { positions: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { positions: {} };
  }
  const checked = validateLayout(parsed);
  return { positions: 'positions' in checked ? checked.positions : {} };
}

/** Route /diagram/layout/save: ghi vị trí (đã kiểm tra); dữ liệu sai thì 400 BAD_LAYOUT. */
export async function layoutSaveRoute(body: Body): Promise<DiagramLayoutSaveResponse> {
  const dir = await resolveProjectDir(body.directory);
  const checked = validateLayout({ positions: body.positions });
  if ('error' in checked) throw new HttpError(400, 'BAD_LAYOUT', checked.error);
  const written = await writeReport(dir, LAYOUT_FILE, `${JSON.stringify({ version: 1, positions: checked.positions }, null, 2)}\n`);
  return { written };
}
