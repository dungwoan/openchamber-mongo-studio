import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { analyze } from './detectors/index.ts';
import { collectFiles } from './schema-scan.ts';
import { MAX_FILE_BYTES, resolveProjectDir } from './project-files.ts';
import type { SchemaReport } from '../shared/api.ts';

const find = (report: SchemaReport, name: string) => report.collections.find((c) => c.name === name);

describe('detector laravel-mongodb (fixture mô phỏng BaseModel/Customer/AuditIndexes của laravel-mongodb sample app)', () => {
  const files = [
    { rel: 'app/Models/BaseModel.php', text: `<?php\nnamespace App\\Models;\nuse MongoDB\\Laravel\\Eloquent\\Model;\nabstract class BaseModel extends Model\n{\n    protected $keyType = 'string';\n}\n` },
    { rel: 'app/Models/Customer.php', text: `<?php\nclass Customer extends BaseModel\n{\n    protected $table = 'customers';\n    protected $fillable = [\n        'customer_name',\n        'cif',\n        'company_id',\n    ];\n    protected $hidden = ['id_no'];\n}\n` },
    { rel: 'app/Models/Cdr.php', text: `<?php\nclass Cdr extends BaseModel\n{\n    protected $table = 'cdr';\n    public static function forTable(string $table): static { return new static; }\n}\n` },
    { rel: 'app/Models/Note.php', text: `<?php\nclass Note extends BaseModel\n{\n    protected $fillable = ['body', 'customer_id'];\n    public function customer()\n    {\n        return $this->belongsTo(Customer::class, 'customer_id');\n    }\n}\n` },
    { rel: 'app/Support/Audit/AuditIndexes.php', text: `<?php\nfinal class AuditIndexes\n{\n    public function ensure(): void\n    {\n        $collection = DB::connection('mongodb')->getCollection('audit_logs');\n        $this->create($collection, ['at' => -1], ['name' => 'at_desc']);\n        $this->create($collection, ['actor.user_id' => 1, 'at' => -1], ['name' => 'actor_at']);\n        $this->create($collection, ['expires_at' => 1], ['name' => 'expires_at_ttl', 'expireAfterSeconds' => 0]);\n    }\n}\n` },
  ];
  const report = analyze(files);

  test('lớp có $table → collection khai báo; không có → snake của tên lớp, suy đoán', () => {
    expect(find(report, 'customers')).toMatchObject({ model: 'Customer', orm: 'laravel-mongodb', confidence: 'declared', file: 'app/Models/Customer.php' });
    expect(find(report, 'note')).toMatchObject({ model: 'Note', confidence: 'inferred' });
    expect(find(report, 'cdr')).toMatchObject({ model: 'Cdr', confidence: 'declared' });
  });

  test('lớp abstract không tạo collection', () => {
    expect(report.collections.some((c) => c.model === 'BaseModel')).toBe(false);
  });

  test('$fillable thành field, $hidden không lộ, BaseModel thêm _id và timestamp', () => {
    const fields = find(report, 'customers')?.fields.map((f) => f.name) ?? [];
    expect(fields).toEqual(expect.arrayContaining(['customer_name', 'cif', 'company_id', '_id', 'createdAt', 'updatedAt']));
    expect(fields).not.toContain('id_no');
    expect(find(report, 'customers')?.fields.find((f) => f.name === '_id')?.pk).toBe(true);
  });

  test('quan hệ belongsTo(Customer::class, "customer_id") nối Note → customers, khai báo', () => {
    expect(report.relations).toContainEqual({ from: 'note', to: 'customers', field: 'customer_id', kind: 'belongsTo', confidence: 'declared' });
  });

  test('index từ createIndex trong *Indexes.php gắn vào collection audit_logs, TTL nhận diện được', () => {
    const audit = find(report, 'audit_logs');
    expect(audit?.indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'at_desc', keys: ['at'] }),
      expect.objectContaining({ name: 'actor_at', keys: ['actor.user_id', 'at'] }),
      expect.objectContaining({ name: 'expires_at_ttl', ttl: true }),
    ]));
  });

  test('detectors ghi nhận đúng tên', () => {
    expect(report.source.detectors).toEqual(['laravel-mongodb']);
  });
});

describe('detector mongoose', () => {
  const report = analyze([
    { rel: 'models/user.js', text: `const userSchema = new Schema({\n  name: { type: String, required: true },\n  customer: { type: Schema.Types.ObjectId, ref: 'Customer' },\n  tags: [String],\n}, { collection: 'app_users' });\nuserSchema.index({ name: 1 }, { unique: true });\nmodule.exports = mongoose.model('User', userSchema);\n` },
    { rel: 'models/customer.js', text: `const s = new Schema({ cif: String });\nmodule.exports = mongoose.model('Customer', s);\n` },
  ]);

  test('collection từ option khai báo; mặc định là tên model số nhiều chữ thường', () => {
    expect(find(report, 'app_users')).toMatchObject({ model: 'User', orm: 'mongoose', confidence: 'declared' });
    expect(find(report, 'customers')).toMatchObject({ model: 'Customer', confidence: 'inferred' });
  });

  test('field có type, required, mảng; ref tạo quan hệ khai báo; index unique', () => {
    const u = find(report, 'app_users');
    expect(u?.fields.find((f) => f.name === 'name')).toMatchObject({ type: 'String', required: true });
    expect(u?.fields.find((f) => f.name === 'tags')?.array).toBe(true);
    expect(report.relations).toContainEqual(expect.objectContaining({ from: 'app_users', to: 'customers', field: 'customer', confidence: 'declared' }));
    expect(u?.indexes).toContainEqual(expect.objectContaining({ keys: ['name'], unique: true }));
  });
});

describe('detector typeorm', () => {
  const report = analyze([
    { rel: 'src/entity/Order.ts', text: `import { Entity, ObjectIdColumn, Column, ManyToOne } from 'typeorm';\n@Entity('orders')\nexport class Order {\n  @ObjectIdColumn()\n  id: ObjectID;\n  @Column()\n  total: number;\n  @Column({ type: 'varchar' })\n  status: string;\n  @ManyToOne(() => Customer)\n  customer: Customer;\n}\n` },
    { rel: 'src/entity/Customer.ts', text: `import { Entity, Column } from 'typeorm';\n@Entity()\nexport class Customer {\n  @Column()\n  name: string;\n}\n` },
  ]);

  test('@Entity("orders") và @Entity() (snake của tên lớp, suy đoán)', () => {
    expect(find(report, 'orders')).toMatchObject({ model: 'Order', orm: 'typeorm', confidence: 'declared' });
    expect(find(report, 'customer')).toMatchObject({ model: 'Customer', confidence: 'inferred' });
  });

  test('@ObjectIdColumn là pk; @Column lấy type; @ManyToOne thành quan hệ belongsTo', () => {
    const o = find(report, 'orders');
    expect(o?.fields.find((f) => f.name === 'id')?.pk).toBe(true);
    expect(o?.fields.find((f) => f.name === 'status')?.type).toBe('varchar');
    expect(report.relations).toContainEqual(expect.objectContaining({ from: 'orders', to: 'customer', kind: 'belongsTo', confidence: 'declared' }));
  });
});

describe('detector prisma', () => {
  const schema = `datasource db {\n  provider = "mongodb"\n  url      = env("DATABASE_URL")\n}\n\nmodel Customer {\n  id     String  @id @default(auto()) @map("_id") @db.ObjectId\n  name   String?\n  orders Order[]\n  @@map("customers")\n}\n\nmodel Order {\n  id         String   @id @map("_id") @db.ObjectId\n  total      Int\n  customerId String   @db.ObjectId\n  customer   Customer @relation(fields: [customerId], references: [id])\n  @@index([customerId])\n}\n`;

  test('provider mongodb: @@map thành tên collection, model không map lấy tên model', () => {
    const report = analyze([{ rel: 'prisma/schema.prisma', text: schema }]);
    expect(find(report, 'customers')).toMatchObject({ model: 'Customer', orm: 'prisma', confidence: 'declared' });
    expect(find(report, 'Order')).toMatchObject({ model: 'Order' });
    expect(report.relations).toContainEqual(expect.objectContaining({ from: 'Order', to: 'customers', field: 'customerId', kind: 'belongsTo' }));
    expect(find(report, 'Order')?.indexes).toContainEqual(expect.objectContaining({ keys: ['customerId'] }));
  });

  test('provider không phải mongodb thì bỏ qua và có cảnh báo', () => {
    const pg = schema.replace('provider = "mongodb"', 'provider = "postgresql"');
    const report = analyze([{ rel: 'prisma/schema.prisma', text: pg }]);
    expect(report.collections).toHaveLength(0);
    expect(report.warnings.join(' ')).toContain('prisma');
  });
});

describe('detector jsonschema và suy đoán theo tên field', () => {
  test('$jsonSchema trong .json: field, bsonType, required, lồng', () => {
    const report = analyze([{
      rel: 'db/validators/audit.json',
      text: JSON.stringify({ collection: 'audit_logs', validator: { $jsonSchema: { bsonType: 'object', required: ['at', 'action'], properties: { at: { bsonType: 'date' }, action: { bsonType: 'string' }, actor: { bsonType: 'object', properties: { user_id: { bsonType: 'string' } } } } } } }),
    }]);
    const a = find(report, 'audit_logs');
    expect(a?.orm).toBe('jsonschema');
    expect(a?.fields.find((f) => f.name === 'at')).toMatchObject({ type: 'date', required: true });
    expect(a?.fields.find((f) => f.name === 'actor')?.children.map((c) => c.name)).toEqual(['user_id']);
  });

  test('field *_id trỏ tới collection có tên khớp và chưa có quan hệ khai báo → suy đoán (inferred)', () => {
    const report = analyze([
      { rel: 'app/Models/Customer.php', text: `<?php\nclass Customer extends Model { protected $table = 'customers'; }\n` },
      { rel: 'app/Models/Ticket.php', text: `<?php\nclass Ticket extends Model { protected $table = 'tickets'; protected $fillable = ['subject', 'customer_id']; }\n` },
    ]);
    expect(report.relations).toContainEqual({ from: 'tickets', to: 'customers', field: 'customer_id', kind: 'reference', confidence: 'inferred' });
  });

  test('không có gì để phát hiện → báo cáo rỗng, không lỗi', () => {
    const report = analyze([{ rel: 'README.md', text: '# hi' }]);
    expect(report.collections).toEqual([]);
    expect(report.relations).toEqual([]);
  });
});

describe('giới hạn quét', () => {
  let sandbox = '';
  beforeAll(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'ms-scan-'));
  });
  afterAll(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });
  const proj = async (name: string, files: Record<string, string>): Promise<string> => {
    const dir = path.join(sandbox, name);
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
    await mkdir(dir, { recursive: true });
    return dir;
  };

  test('chỉ đọc đuôi cho phép; bỏ .env, compose, thư mục node_modules/.git/venv/ẩn', async () => {
    const dir = await proj('ext', {
      'app/Models/A.php': '<?php', 'schema.prisma': 'x', 'v.json': '{}',
      'README.md': 'x', '.env': 'MONGO_URI=x', 'docker-compose.yml': 'x', 'app/log.txt': 'x',
      'node_modules/p/a.js': 'x', '.git/h.js': 'x', 'venv/b.py': 'x', '.hidden/c.js': 'x',
    });
    const { files } = await collectFiles(await resolveProjectDir(dir));
    expect(files.map((f) => f.rel)).toEqual(['app/Models/A.php', 'schema.prisma', 'v.json']);
  });

  test('độ sâu tối đa 6 thư mục', async () => {
    const dir = await proj('depth', { 'a/b/c/d/e/f/ok.php': '<?php', 'a/b/c/d/e/f/g/no.php': '<?php' });
    const { files } = await collectFiles(await resolveProjectDir(dir));
    expect(files.map((f) => f.rel)).toEqual(['a/b/c/d/e/f/ok.php']);
  });

  test('symlink (file hoặc thư mục) bị bỏ qua', async () => {
    const outside = await proj('outside', { 'secret.php': '<?php' });
    const dir = await proj('links', { 'real.php': '<?php' });
    await symlink(path.join(outside, 'secret.php'), path.join(dir, 'link.php'));
    await symlink(outside, path.join(dir, 'linkdir'));
    const { files } = await collectFiles(await resolveProjectDir(dir));
    expect(files.map((f) => f.rel)).toEqual(['real.php']);
  });

  test('file lớn hơn MAX_FILE_BYTES bị bỏ qua', async () => {
    const dir = await proj('big', { 'big.php': 'x'.repeat(MAX_FILE_BYTES + 1), 'small.php': '<?php' });
    const { files, warnings } = await collectFiles(await resolveProjectDir(dir));
    expect(files.map((f) => f.rel)).toEqual(['small.php']);
    expect(warnings.join(' ')).toContain('too large');
  });

  test('trần số file: dừng và đánh dấu truncated', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) files[`m${i}.php`] = '<?php';
    const dir = await proj('cap', files);
    const scan = await collectFiles(await resolveProjectDir(dir), { maxFiles: 3 });
    expect(scan.files).toHaveLength(3);
    expect(scan.truncated).toBe(true);
  });
});
