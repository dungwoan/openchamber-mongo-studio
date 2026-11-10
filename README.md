# Mongo Studio

Extension cho OpenChamber: kết nối MongoDB, duyệt collection, xem và sửa document, và chạy truy vấn kiểu mongo shell (tương tự NoSQLBooster).

## Cấu trúc

| Đường dẫn | Vai trò |
|---|---|
| `panel/` | Giao diện (iframe sandbox): cây Connection → Database → Collection, tab Collection, tab Query |
| `service/` | Service Node chạy trên máy: giữ MongoDB client, lưu connection, chạy truy vấn |
| `shared/query-parser.ts` | Parser cú pháp mongo shell, dùng chung cho panel (kiểm tra) và service (chạy). Không dùng eval |
| `shared/api.ts` | Kiểu dữ liệu của hợp đồng panel ↔ service |

## Cài đặt cho người dùng

Cách 1: mở Settings → Extensions, thêm bằng URL:

```
https://github.com/dungwoan/openchamber-mongo-studio
```

Cách 2: bấm nút sau (mở ứng dụng OpenChamber desktop, sẽ hỏi xác nhận trước khi tải):

[Cài đặt Mongo Studio](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2Fdungwoan%2Fopenchamber-mongo-studio)

> Lưu ý: mật khẩu của connection được lưu dạng **văn bản thuần** trong `~/.openchamber-mongo-studio/connections.json` (quyền `0600`). Ai đăng nhập được vào tài khoản hệ điều hành này đều đọc được. Xem mục Bảo mật bên dưới.

## Cài đặt và kiểm tra

```bash
bun install
bunx openchamber-guest-bundle panel/main.ts panel/main.js
bunx openchamber-guest-bundle --node service/main.ts service/main.js
bunx openchamber-guest-check
bun test shared/
```

Sau đó thêm thư mục này trong Settings → Extensions.

## Bảo mật

- URI (kèm mật khẩu) được lưu trong `~/.openchamber-mongo-studio/connections.json`, quyền `0600`, thư mục `0700`. Đây là văn bản thuần: ai đọc được file này (cùng tài khoản hệ điều hành) đều thấy mật khẩu.
- Panel không bao giờ nhận URI đầy đủ. Danh sách connection chỉ có tên, host (đã bỏ thông tin đăng nhập) và trạng thái.
- Service chỉ nghe trên `127.0.0.1` và yêu cầu bearer token trên mọi route, kể cả `/health`.
- Connection Read-only chặn mọi thao tác ghi, kể cả `$out`/`$merge` trong aggregate.

## Cú pháp truy vấn

`db.<collection>.find(filter, projection).sort(...).skip(n).limit(n)`, `findOne`, `count`/`countDocuments`, `distinct`, `aggregate([...], {allowDiskUse, maxTimeMS})`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `db.getCollectionNames()`, `db.stats()`, và `db.getCollection("tên")`.

Đối số là JS literal nới lỏng: key không nháy, nháy đơn/đôi, dấu phẩy thừa, comment, regex `/abc/i`, và `ObjectId`, `ISODate`, `new Date`, `NumberLong`, `NumberInt`, `NumberDecimal`, `UUID`. Hàm khác bị từ chối kèm vị trí dòng và cột.

Ctrl/⌘ + Enter chạy lệnh tại con trỏ. Find và aggregate trả tối đa 500 dòng.
