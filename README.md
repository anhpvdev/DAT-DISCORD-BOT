# Daily Report Discord Bot

Bot gửi form daily report qua DM cho tất cả member có role được cấu hình. Bot có 2 mốc giờ theo giờ Việt Nam:

- `REPORT_START_TIME`, mặc định `08:00`: report đầu ngày.
- `REPORT_END_TIME`, mặc định `17:00`: report cuối ngày.
- `REPORT_DURATION`, mặc định `60` phút: thời gian member được phép gửi report kể từ mốc giờ report.

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
REPORT_DURATION=60
```

`GUILD_IDS` và `TARGET_ROLE_IDS` dùng format comma-separated. Bot vẫn đọc được biến cũ `GUILD_ID` và `TARGET_ROLE_ID`, nhưng nên đổi sang biến số nhiều để rõ nghĩa.

`REPORT_START_TIME` và `REPORT_END_TIME` dùng format `HH:mm`. Biến cũ `REPORT_TIMES` không còn được dùng vì form đầu ngày và cuối ngày có bộ câu hỏi khác nhau. Timezone đã được hard-code là `Asia/Ho_Chi_Minh`.

`REPORT_DURATION` tính theo phút nếu dùng số nguyên, ví dụ `60`. Bot cũng chấp nhận `60m` hoặc `1h`. Hết thời gian này, bot sẽ chặn cả việc mở form và submit form.

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
