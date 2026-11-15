[English](README.md) | Tiếng Việt

# Mongo Studio

Extension cho OpenChamber: kết nối MongoDB, duyệt Collection, xem và sửa Document, và chạy Query theo cú pháp mongo shell (tương tự NoSQLBooster).

## Cấu trúc

| Đường dẫn | Vai trò |
|---|---|
| `panel/` | Giao diện (iframe sandbox): cây Connection → Database → Collection, tab Collection, tab Query |
| `service/` | Service Node chạy trên máy: giữ MongoDB client, lưu Connection, chạy Query |
| `shared/query-parser.ts` | Parser cú pháp mongo shell, dùng chung cho panel (kiểm tra) và service (chạy). Không dùng `eval` |
| `shared/api.ts` | Kiểu dữ liệu của hợp đồng panel ↔ service |

## Cài đặt cho người dùng

Cách 1: mở Settings → Extensions, thêm bằng URL:

```
https://github.com/dungwoan/openchamber-mongo-studio
```

Cách 2: bấm nút sau (mở ứng dụng OpenChamber desktop, sẽ hỏi xác nhận trước khi tải):

[Cài đặt Mongo Studio](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2Fdungwoan%2Fopenchamber-mongo-studio)

> Lưu ý: mật khẩu của Connection được lưu dạng **plain text** trong `~/.openchamber-mongo-studio/connections.json` (quyền `0600`). Ai đăng nhập được vào tài khoản hệ điều hành này đều đọc được. Xem mục Bảo mật bên dưới.

## Cài đặt và kiểm tra

```bash
bun install
bunx openchamber-guest-bundle panel/main.ts panel/main.js
bunx openchamber-guest-bundle --node service/main.ts service/main.js
bunx openchamber-guest-check
bun test
```

Sau đó thêm thư mục này trong Settings → Extensions.

## Tự kết nối theo dự án

Khi panel mở trong một thư mục dự án, Mongo Studio tự kết nối tới database của dự án đó, theo thứ tự:

1. Connection bạn chọn gần nhất cho dự án này, nếu nó vẫn còn được lưu.
2. Nếu không có, lấy giá trị `MONGODB_URI`, `MONGO_URI`, `MONGODB_URL`, `DATABASE_URL` hoặc `MONGODB_DSN` bắt đầu bằng `mongodb://` hoặc `mongodb+srv://`, đọc từ `.env`, `.env.local`, `.env.development`, `.env.development.local`, `docker-compose.yml` hoặc `compose.yml` Tìm trong thư mục dự án trước, rồi trong các thư mục con trực tiếp (chỉ một cấp, ví dụ `backend/.env`); file ở thư mục gốc thắng file ở thư mục con, và trong cùng một thư mục vẫn theo thứ tự trên. Bỏ qua thư mục ẩn, `node_modules`, `vendor`, `dist`, `build`, `.git`, `venv*` và `*.egg-info`; nếu dự án có hơn 100 thư mục con thì chỉ quét thư mục gốc. Không bao giờ đọc thư mục cha.

Banner cho biết đã kết nối gì, kèm nút **Ngắt**. Ngắt thì lần mở sau sẽ không tự nối nữa, cho tới khi bạn chọn lại connection trong cây. Connection lấy từ file của dự án chỉ nằm trong bộ nhớ: không ghi vào `connections.json`, không sửa hay xoá được trong cây, và luôn **chỉ đọc (read-only)**: mọi thao tác ghi (thêm, sửa, xoá và lệnh ghi ở tab Query) đều bị chặn. Muốn ghi vào database đó, tự thêm connection bằng **Add connection** và bỏ chọn Read-only. Mọi file của dự án chỉ được đọc; file hoặc thư mục con là symlink trỏ ra ngoài thư mục dự án sẽ bị bỏ qua.

Nếu tên host trong URI không phân giải được trên máy này (ví dụ `mongo`, tên service của mạng Docker Compose), banner sẽ báo `Không phân giải được host …`. Hãy dùng connection cổng public, hoặc tự thêm connection bằng URI dùng được trên máy này.

## Sơ đồ database

Nút **Diagram** mở một tab vẽ các collection và quan hệ của dự án đang mở. Mongo Studio chỉ đọc file mã nguồn (`.ts`, `.js`, `.mjs`, `.php`, `.prisma`, `.json`; tối đa 6 cấp thư mục, 2000 file, mỗi file 256 KB). Bỏ qua `node_modules`, `vendor`, `dist`, `build`, `.git`, thư mục ẩn và `venv*`. Bộ nhận diện: Laravel (laravel-mongodb), Mongoose, TypeORM, Prisma (chỉ provider MongoDB) và file `$jsonSchema`.

- Mục **Diagrams** ở cột trái liệt kê dự án đang mở; bấm vào để mở tab sơ đồ.
- Dải tiêu đề liền và nét liền là khai báo trong code. Nét đứt và thẻ đứt là suy ra từ tên field, ví dụ field `customer_id` trỏ tới `customers`. Mỗi đường quan hệ có màu riêng (xanh cho khai báo, cam cho suy ra) và mũi tên.
- **Hiển thị quan hệ** bật hoặc tắt toàn bộ đường quan hệ (mặc định bật). Tắt thì không còn cạnh nào; các thẻ bảng vẫn giữ nguyên.
- Kéo bảng bằng dải tiêu đề để di chuyển; đường nối đi theo. **Sắp xếp lại** đưa về bố cục tự động. Vị trí đã kéo chỉ giữ trong phiên panel hiện tại, không được lưu.
- **Ghi báo cáo dự án** (một lần bấm) ghi `.openchamber/mongo-studio/schema-scan.json` vào dự án và báo đường dẫn. Mongo Studio không bao giờ sửa `.gitignore`; bạn tự thêm dòng `.openchamber/`. Nếu `.openchamber` là symlink, việc ghi bị từ chối kèm giải thích.
- Khi không tìm thấy model nào, **Nhờ agent bổ sung** đặt một lời nhắc vào ô nhập của chat, thay nội dung hiện có (không gửi). Lời nhắc yêu cầu agent ghi `.openchamber/mongo-studio/schema-report.json`; Mongo Studio kiểm tra file đó rồi gộp vào sơ đồ. Tính năng này dùng capability `prompt`, cần được duyệt khi cài.
- Khi có hơn 80 collection, dùng ô tìm kiếm hoặc chọn một collection trung tâm và số bước lân cận.

## Bảo mật

- URI (kèm mật khẩu) được lưu trong `~/.openchamber-mongo-studio/connections.json`, quyền `0600`, thư mục `0700`. Đây là plain text: ai đọc được file này (cùng tài khoản hệ điều hành) đều thấy mật khẩu.
- Panel không bao giờ nhận URI đầy đủ. Danh sách Connection chỉ có tên, host (đã bỏ thông tin đăng nhập) và trạng thái.
- Service chỉ nghe trên `127.0.0.1` và yêu cầu bearer token trên mọi route, kể cả `/health`.
- Connection Read-only chặn mọi thao tác ghi, kể cả `$out`/`$merge` trong aggregate.

## Cú pháp Query

`db.<collection>.find(filter, projection).sort(...).skip(n).limit(n)`, `findOne`, `count`/`countDocuments`, `distinct`, `aggregate([...], {allowDiskUse, maxTimeMS})`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `db.getCollectionNames()`, `db.stats()`, và `db.getCollection("tên")`.

Đối số là JS literal nới lỏng: key không nháy, nháy đơn/đôi, dấu phẩy thừa, comment, regex `/abc/i`, và `ObjectId`, `ISODate`, `new Date`, `NumberLong`, `NumberInt`, `NumberDecimal`, `UUID`. Hàm khác bị từ chối kèm vị trí dòng và cột.

Ctrl/⌘ + Enter chạy lệnh tại con trỏ. Find và aggregate trả tối đa 500 dòng.
