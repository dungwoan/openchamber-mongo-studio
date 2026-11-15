/**
 * Chỉ dùng cho test (project.test.ts): chạy trong process con có HOME tạm, vì os.homedir() của Bun
 * không theo biến HOME đổi lúc đang chạy. In một dòng JSON báo cáo ra stdout.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { registerDetected } from './detected.ts';
import { changeProjects, listProjects } from './store.ts';

const dataDir = path.join(os.homedir(), '.openchamber-mongo-studio');
const file = path.join(dataDir, 'projects.json');
const key = '/tmp/store-proj';

await changeProjects((map) => ({ map: { ...map, [key]: { connectionId: 'c1' } }, result: undefined }));
const first = await stat(file);
await changeProjects((map) => ({ map: { ...map }, result: undefined }));
const second = await stat(file);

const report: Record<string, unknown> = {
  fileMode: first.mode & 0o777,
  dirMode: (await stat(dataDir)).mode & 0o777,
  unchangedSkipsWrite: first.mtimeMs === second.mtimeMs,
  listed: (await listProjects())[key],
};

await writeFile(file, '{ not json');
report.corruptListed = await listProjects();
await changeProjects((map) => ({ map: { ...map, '/x': { detected: true } }, result: undefined }));
report.rewritten = JSON.parse(await readFile(file, 'utf8'));

registerDetected('/tmp/proj-x', { kind: 'found', uri: 'mongodb://h/db', sourceFile: '.env', key: 'MONGO_URI' });
report.connectionsFileCreated = await stat(path.join(dataDir, 'connections.json')).then(
  () => true,
  () => false,
);

console.log(JSON.stringify(report));
