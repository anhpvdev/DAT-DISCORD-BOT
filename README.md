# Daily Report Discord Bot

Bot gửi form daily report qua DM cho tất cả member có role được cấu hình. Bot có 2 mốc giờ theo giờ Việt Nam:

- `REPORT_START_TIME`, mặc định `08:00`: report đầu ngày.
- `REPORT_END_TIME`, mặc định `17:00`: report cuối ngày.

Khi user điền form, report sẽ được gửi về channel admin.

## Setup

1. Tạo file `.env` từ `.env.example`.
2. Điền các biến:

```env
DISCORD_TOKEN=your_bot_token_here
GUILD_IDS=your_discord_server_id_here,another_guild_id_here
TARGET_ROLE_IDS=role_id_to_collect_daily_report_from,another_role_id_here
REPORT_CHANNEL_ID=channel_id_for_admin_reports
REPORT_START_TIME=08:00
REPORT_END_TIME=17:00
```

`GUILD_IDS` và `TARGET_ROLE_IDS` dùng format comma-separated. Bot vẫn đọc được biến cũ `GUILD_ID` và `TARGET_ROLE_ID`, nhưng nên đổi sang biến số nhiều để rõ nghĩa.

`REPORT_START_TIME` và `REPORT_END_TIME` dùng format `HH:mm`. Biến cũ `REPORT_TIMES` không còn được dùng vì form đầu ngày và cuối ngày có bộ câu hỏi khác nhau. Timezone đã được hard-code là `Asia/Ho_Chi_Minh`.

Bot không giới hạn thời gian mở form hoặc submit form. Khi gửi prompt mới, bot sẽ xóa prompt cũ cùng loại report trong DM của user trước để tránh có nhiều nút đầu ngày hoặc nhiều nút cuối ngày cùng tồn tại.

## Thông Báo Lịch Họp Từ Google Calendar

Bot đọc lịch Google Calendar qua link iCal bí mật và gửi thông báo vào một channel trước giờ họp. Tính năng này tự tắt nếu thiếu `GCAL_ICS_URL` hoặc `MEETING_CHANNEL_ID`.

```env
GCAL_ICS_URL=https://calendar.google.com/calendar/ical/.../private-.../basic.ics
MEETING_CHANNEL_ID=channel_id_to_post_meeting_reminders
MEETING_KEYWORDS=sprint planning,meeting
MEETING_ORGANIZER_EMAIL=
MEETING_REMIND_BEFORE_MINUTES=240
MEETING_POLL_INTERVAL_MINUTES=5
MEETING_MENTION_ROLE_IDS=
MEETING_ROOM_CATEGORY_ID=
```

- `GCAL_ICS_URL`: Google Calendar web → Settings → chọn calendar của bạn → Integrate calendar → **Secret address in iCal format**. Không dùng "Public URL" hay "Public address". Link này là bí mật, chỉ để trong `.env`.
- `MEETING_KEYWORDS`: chỉ báo các event có title chứa một trong các từ khóa (không phân biệt hoa thường và dấu). Đặt `*` để báo mọi event.
- `MEETING_ORGANIZER_EMAIL`: nếu điền, chỉ báo event do email này tạo.
- `MEETING_REMIND_BEFORE_MINUTES`: báo trước giờ họp bao nhiêu phút, mặc định `240` (4 tiếng).
- `MEETING_ROOM_CATEGORY_ID`: ID của category chứa phòng họp (voice channel) do bot tạo. Nếu điền ID của một channel thường, phòng được đặt cùng category với channel đó.
- `MEETING_MENTION_ROLE_IDS`: các role tham dự họp, comma-separated. Bỏ trống thì dùng chung `TARGET_ROLE_IDS` của daily report.

Mỗi lần diễn ra của một lịch chỉ được báo 1 lần. Nếu bot khởi động khi lịch còn dưới 4 tiếng mà chưa báo, bot báo ngay. Lịch bị dời sang giờ khác được coi là lịch mới. Event cả ngày và event đã hủy bị bỏ qua.

Mỗi thông báo gồm:

- Tiêu đề và thời gian họp.
- Ping từng member (không phải bot) của các role tham dự. Nếu quá nhiều người để ping trong 1 tin nhắn thì ping theo role.
- Nút **Xác nhận tham gia** và **Báo bận** (kèm lý do, không bắt buộc).
- Danh sách người tham dự: mỗi người là một embed nhỏ gồm avatar + tên + trạng thái, viền xanh khi đã xác nhận, đỏ khi báo bận, xám khi chưa phản hồi. Từ 10 người trở lên thì chuyển sang danh sách dạng text (Discord giới hạn 10 embed mỗi tin nhắn).
- Một voice channel riêng đặt tên theo tiêu đề lịch, tạo trong category `MEETING_ROOM_CATEGORY_ID` (bỏ trống thì cùng category với channel thông báo), chỉ các role tham dự mới thấy và vào được, link phòng nằm ngay trong thông báo. Phòng tự bị xóa sau 23:59 cùng ngày (giờ Việt Nam), lúc đó các nút trên thông báo cũng bị gỡ.

Trạng thái (lịch đã báo, phản hồi, phòng họp cần xóa) được lưu ở `data/meeting-notified.json`. Nếu chạy bằng Docker, giữ volume `./data` trong `docker-compose.yml` để không bị báo lại và không sót phòng chưa xóa sau khi rebuild.

Quyền bot cần có trong server: View Channel, Send Messages, Embed Links, **Manage Channels**, Connect. Nếu bot không tạo được phòng, thông báo vẫn được gửi kèm cảnh báo, và bot tự thử tạo lại mỗi lần quét cho đến hết ngày. Tính năng này cần Node.js 22 trở lên.

## Nội Dung Form

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

## Discord Bot Settings

Trong Discord Developer Portal, bot cần:

- Server Members Intent: bật, để bot lấy danh sách member theo role.
- Bot permission trong server: xem server/member, gửi tin nhắn vào report channel.
- User phải cho phép DM từ server thì bot mới gửi form qua DM được.

## Run

```bash
npm install
npm start
```

Nếu chạy trên PowerShell và bị chặn `npm.ps1`, dùng:

```bash
npm.cmd install
npm.cmd start
```

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
