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
2. Nếu không có, lấy giá trị `MONGODB_URI`, `MONGO_URI`, `MONGODB_URL`, `DATABASE_URL` hoặc `MONGODB_DSN` bắt đầu bằng `mongodb://` hoặc `mongodb+srv://`, đọc từ `.env`, `.env.local`, `.env.development`, `.env.development.local`, `docker-compose.yml` hoặc `compose.yml` trong thư mục dự án (không đọc thư mục cha).

Banner cho biết đã kết nối gì, kèm nút **Ngắt**. Ngắt thì lần mở sau sẽ không tự nối nữa, cho tới khi bạn chọn lại connection trong cây. Connection lấy từ file của dự án chỉ nằm trong bộ nhớ: không ghi vào `connections.json`, không sửa hay xoá được trong cây, và luôn **chỉ đọc (read-only)**: mọi thao tác ghi (thêm, sửa, xoá và lệnh ghi ở tab Query) đều bị chặn. Muốn ghi vào database đó, tự thêm connection bằng **Add connection** và bỏ chọn Read-only. Mọi file của dự án chỉ được đọc; file là symlink trỏ ra ngoài thư mục dự án sẽ bị bỏ qua.

## Bảo mật

- URI (kèm mật khẩu) được lưu trong `~/.openchamber-mongo-studio/connections.json`, quyền `0600`, thư mục `0700`. Đây là plain text: ai đọc được file này (cùng tài khoản hệ điều hành) đều thấy mật khẩu.
- Panel không bao giờ nhận URI đầy đủ. Danh sách Connection chỉ có tên, host (đã bỏ thông tin đăng nhập) và trạng thái.
- Service chỉ nghe trên `127.0.0.1` và yêu cầu bearer token trên mọi route, kể cả `/health`.
- Connection Read-only chặn mọi thao tác ghi, kể cả `$out`/`$merge` trong aggregate.

## Cú pháp Query

`db.<collection>.find(filter, projection).sort(...).skip(n).limit(n)`, `findOne`, `count`/`countDocuments`, `distinct`, `aggregate([...], {allowDiskUse, maxTimeMS})`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `db.getCollectionNames()`, `db.stats()`, và `db.getCollection("tên")`.

Đối số là JS literal nới lỏng: key không nháy, nháy đơn/đôi, dấu phẩy thừa, comment, regex `/abc/i`, và `ObjectId`, `ISODate`, `new Date`, `NumberLong`, `NumberInt`, `NumberDecimal`, `UUID`. Hàm khác bị từ chối kèm vị trí dòng và cột.

Ctrl/⌘ + Enter chạy lệnh tại con trỏ. Find và aggregate trả tối đa 500 dòng.
