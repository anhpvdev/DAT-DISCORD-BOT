# DAT Discord Bot

Bot có 2 tính năng độc lập:

- **Daily report**: gửi form daily report qua DM cho member có role được cấu hình, kết quả gửi về channel admin.
- **Sprint notification**: đọc lịch họp từ Google Calendar, nhắc vào channel trước giờ họp, nhận phản hồi tham gia / báo bận và tạo phòng họp (voice channel) riêng.

## Cấu Trúc Code

```text
index.js               Khởi tạo Discord client, nạp config, nối các module
src/config.js          Đọc và kiểm tra toàn bộ biến môi trường
src/utils.js           Hàm dùng chung (timezone, bỏ dấu, cắt chuỗi)
src/dailyReport.js     Module daily report
src/sprintNotifier.js  Module sprint notification
data/                  Trạng thái của sprint notification (không commit)
```

Mỗi module export cùng một kiểu:

- `start(client, config)`: chạy khi bot sẵn sàng.
- `handleInteraction(interaction)`: trả về `true` nếu interaction (nút, form) thuộc về module đó.
- `dailyReport.handleMessage(message)`: lệnh `/resend`.

Thêm tính năng mới: tạo file trong `src/`, thêm phần đọc env vào `src/config.js`, rồi gọi `start` / `handleInteraction` trong `index.js`.

## Setup

Tạo file `.env` từ `.env.example` và điền các biến. Các biến có đuôi `_IDS` nhận nhiều id cách nhau bằng dấu phẩy. Timezone cố định là `Asia/Ho_Chi_Minh`.

### Chung

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `DISCORD_TOKEN` | Có | Token của bot |
| `DISCORD_GUILD_IDS` | Có | Server chạy daily report |

### Daily report

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `REPORT_ROLE_IDS` | Có | Role nhận phiếu daily report qua DM |
| `REPORT_CHANNEL_ID` | Có | Channel nhận kết quả report |
| `REPORT_START_TIME` | Không | Giờ gửi report đầu ngày, `HH:mm`, mặc định `08:00` |
| `REPORT_END_TIME` | Không | Giờ gửi report cuối ngày, `HH:mm`, mặc định `17:00` |

### Sprint notification

Tính năng tắt khi bỏ trống `SPRINT_CALENDAR_ICS_URL`. Khi đã điền link thì các biến bắt buộc còn lại phải có.

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `SPRINT_CALENDAR_ICS_URL` | Có | Link iCal bí mật của Google Calendar |
| `SPRINT_NOTIFY_CHANNEL_ID` | Có | Channel nhận thông báo lịch họp |
| `SPRINT_ROLE_IDS` | Có | Role được ping và được vào phòng họp |
| `SPRINT_VOICE_CATEGORY_ID` | Không | Category chứa phòng họp. Bỏ trống thì cùng category với channel thông báo. Nếu điền id một channel thường, phòng được đặt cùng category với channel đó |
| `SPRINT_KEYWORDS` | Không | Chỉ báo event có title chứa một trong các từ khóa, cách nhau bằng dấu phẩy, không phân biệt hoa thường và dấu. `*` khớp chuỗi bất kỳ: `"[WG] Sprint*#*"` khớp "[WG] Sprint Planning #18", "[WG] Sprint Review #19". Đặt `*` để báo mọi event. Mặc định `sprint planning,meeting` |
| `SPRINT_ORGANIZER_EMAIL` | Không | Chỉ báo event do email này tạo |
| `SPRINT_REMIND_TIME` | Không | Giờ nhắc lịch họp trong ngày, `HH:mm`, mặc định `08:00` |
| `SPRINT_POLL_INTERVAL_MINUTES` | Không | Bao lâu đọc lịch một lần, mặc định `5` |

Giá trị có ký tự `#` (ví dụ `SPRINT_KEYWORDS`) phải đặt trong dấu nháy kép, nếu không phần từ `#` trở đi bị coi là comment.

Lấy `SPRINT_CALENDAR_ICS_URL`: Google Calendar web → Settings → chọn calendar của bạn → Integrate calendar → **Secret address in iCal format** (link có `private-` và kết thúc bằng `basic.ics`). Không dùng "Public URL" hay "Public address". Link này là bí mật, chỉ để trong `.env`; nếu lộ thì bấm **Reset** ở chỗ đó để tạo link mới.

### Đổi tên biến env

Các tên cũ không còn được dùng. Nếu `.env` còn tên cũ, bot sẽ dừng ngay khi khởi động và in ra danh sách cần đổi.

| Tên cũ | Tên mới |
|---|---|
| `GUILD_ID`, `GUILD_IDS` | `DISCORD_GUILD_IDS` |
| `TARGET_ROLE_ID`, `TARGET_ROLE_IDS` | `REPORT_ROLE_IDS` |
| `GCAL_ICS_URL` | `SPRINT_CALENDAR_ICS_URL` |
| `MEETING_CHANNEL_ID` | `SPRINT_NOTIFY_CHANNEL_ID` |
| `MEETING_MENTION_ROLE_IDS` | `SPRINT_ROLE_IDS` (trước đây bỏ trống thì dùng role daily report; giờ phải điền) |
| `METTING_CHANNEL`, `MEETING_ROOM_CATEGORY_ID` | `SPRINT_VOICE_CATEGORY_ID` |
| `MEETING_KEYWORDS` | `SPRINT_KEYWORDS` |
| `MEETING_ORGANIZER_EMAIL` | `SPRINT_ORGANIZER_EMAIL` |
| `MEETING_REMIND_BEFORE_MINUTES`, `SPRINT_REMIND_BEFORE_MINUTES` | `SPRINT_REMIND_TIME` (giờ `HH:mm` thay vì số phút) |
| `MEETING_POLL_INTERVAL_MINUTES` | `SPRINT_POLL_INTERVAL_MINUTES` |

## Daily Report

Bot gửi phiếu vào DM ở 2 mốc giờ trong ngày làm việc (thứ 2 đến thứ 6). Bot không giới hạn thời gian mở form hoặc submit form. Khi gửi phiếu mới, bot xóa phiếu cũ cùng loại trong DM để tránh có nhiều nút cùng tồn tại.

Member gõ `/resend sang` hoặc `/resend chieu` trong server để nhận lại phiếu.

Report đầu ngày:

```text
Ngày hôm nay của bạn thế nào?
Hôm nay bạn sẽ làm những công việc gì?
Bạn có gặp vướng mắc hay cần hỗ trợ gì không?
```

Report cuối ngày:

```text
Ngày hôm nay bạn đã hoàn thành những công việc gì?
Dự định tiếp theo của bạn là gì?
Bạn có gặp vướng mắc hay cần hỗ trợ gì không?
```

## Sprint Notification

Đến `SPRINT_REMIND_TIME` mỗi ngày, bot nhắc các lịch họp trong ngày đó (chưa bắt đầu). Lịch bắt đầu trước giờ nhắc (ví dụ họp 07:00, nhắc 08:00) được nhắc từ hôm trước, cùng giờ nhắc. Lịch tạo sau giờ nhắc, hoặc bot khởi động muộn hơn giờ nhắc, thì lịch chưa báo được báo ngay ở lần quét kế tiếp. Mỗi lần diễn ra của một lịch chỉ được báo 1 lần. Lịch bị dời sang giờ khác được coi là lịch mới. Event cả ngày và event đã hủy bị bỏ qua.

Mỗi thông báo gồm:

- Tiêu đề và thời gian họp.
- Ping từng member (không phải bot) của `SPRINT_ROLE_IDS`. Nếu quá nhiều người để ping trong 1 tin nhắn thì ping theo role.
- Nút **Xác nhận tham gia** và **Báo bận** (kèm lý do, không bắt buộc).
- Danh sách người tham dự: mỗi người là một embed nhỏ gồm avatar + tên + trạng thái, viền xanh khi đã xác nhận, đỏ khi báo bận, xám khi chưa phản hồi. Từ 10 người trở lên thì chuyển sang danh sách dạng text (Discord giới hạn 10 embed mỗi tin nhắn).
- Một voice channel riêng đặt tên theo tiêu đề lịch, chỉ `SPRINT_ROLE_IDS` mới thấy và vào được, link phòng nằm ngay trong thông báo. Phòng tự bị xóa sau 23:59 cùng ngày (giờ Việt Nam), lúc đó các nút trên thông báo cũng bị gỡ.

Trạng thái (lịch đã báo, phản hồi, phòng họp cần xóa) được lưu ở `data/meeting-notified.json`. Nếu chạy bằng Docker, giữ volume `./data` trong `docker-compose.yml` để không bị báo lại và không sót phòng chưa xóa sau khi rebuild.

Nếu bot không tạo được phòng, thông báo vẫn được gửi kèm cảnh báo, và bot tự thử tạo lại mỗi lần quét cho đến hết ngày.

## Discord Bot Settings

Trong Discord Developer Portal, bot cần:

- Server Members Intent và Message Content Intent: bật.
- Quyền trong server: View Channel, Send Messages, Embed Links, **Manage Channels** (tạo / xóa phòng họp), Connect.
- User phải cho phép DM từ server thì bot mới gửi form daily report qua DM được.

## Run

Cần Node.js 22 trở lên.

```bash
npm install
npm start
```

Nếu chạy trên PowerShell và bị chặn `npm.ps1`, dùng:

```bash
npm.cmd install
npm.cmd start
```

`npm run check` kiểm tra cú pháp toàn bộ file.

## Deploy With PM2

Trên server Linux:

```bash
chmod +x deploy.sh
./deploy.sh
```

Mặc định PM2 process name là `dailybot`. Có thể đổi bằng:

```bash
PM2_APP_NAME=dailybot-prod ./deploy.sh
```

Script sẽ chạy `npm ci --omit=dev`, start/restart bot bằng PM2, sau đó `pm2 save`.
