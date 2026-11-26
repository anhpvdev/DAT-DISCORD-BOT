const { VIETNAM_TIME_ZONE } = require('./utils');

const DEFAULT_REPORT_START_TIME = '08:00';
const DEFAULT_REPORT_END_TIME = '17:00';
const DEFAULT_SPRINT_KEYWORDS = 'sprint planning,meeting';
const DEFAULT_SPRINT_REMIND_TIME = '08:00';
const DEFAULT_SPRINT_POLL_INTERVAL_MINUTES = 5;

// Tên biến cũ -> tên mới. Bot dừng ngay nếu .env còn tên cũ, tránh chạy với cấu hình bị thiếu.
const RENAMED_ENV = {
  GUILD_ID: 'DISCORD_GUILD_IDS',
  GUILD_IDS: 'DISCORD_GUILD_IDS',
  TARGET_ROLE_ID: 'REPORT_ROLE_IDS',
  TARGET_ROLE_IDS: 'REPORT_ROLE_IDS',
  GCAL_ICS_URL: 'SPRINT_CALENDAR_ICS_URL',
  MEETING_CHANNEL_ID: 'SPRINT_NOTIFY_CHANNEL_ID',
  MEETING_MENTION_ROLE_IDS: 'SPRINT_ROLE_IDS',
  METTING_CHANNEL: 'SPRINT_VOICE_CATEGORY_ID',
  MEETING_ROOM_CATEGORY_ID: 'SPRINT_VOICE_CATEGORY_ID',
  MEETING_KEYWORDS: 'SPRINT_KEYWORDS',
  MEETING_ORGANIZER_EMAIL: 'SPRINT_ORGANIZER_EMAIL',
  MEETING_REMIND_BEFORE_MINUTES: 'SPRINT_REMIND_TIME (HH:mm)',
  SPRINT_REMIND_BEFORE_MINUTES: 'SPRINT_REMIND_TIME (HH:mm)',
  MEETING_POLL_INTERVAL_MINUTES: 'SPRINT_POLL_INTERVAL_MINUTES',
};

function loadConfig() {
  assertNoRenamedEnv();

  return {
    token: readRequiredEnv('DISCORD_TOKEN'),
    dailyReport: loadDailyReportConfig(),
    sprint: loadSprintConfig(),
  };
}

function loadDailyReportConfig() {
  return {
    guildIds: readIdList('DISCORD_GUILD_IDS'),
    roleIds: readIdList('REPORT_ROLE_IDS'),
    channelId: readIdList('REPORT_CHANNEL_ID')[0],
    startTime: readTime('REPORT_START_TIME', DEFAULT_REPORT_START_TIME),
    endTime: readTime('REPORT_END_TIME', DEFAULT_REPORT_END_TIME),
    timeZone: VIETNAM_TIME_ZONE,
  };
}

// Trả về null (tắt tính năng) khi chưa điền link lịch.
function loadSprintConfig() {
  const icsUrl = readEnv('SPRINT_CALENDAR_ICS_URL');

  if (!icsUrl) {
    return null;
  }

  if (!/\.ics(?:\?|$)/i.test(icsUrl)) {
    console.warn(
      'SPRINT_CALENDAR_ICS_URL does not look like an iCal link. Use "Secret address in iCal format" (ends with basic.ics), not the public/embed URL.'
    );
  }

  const voiceCategoryId = readEnv('SPRINT_VOICE_CATEGORY_ID');

  return {
    icsUrl,
    notifyChannelId: readIdList('SPRINT_NOTIFY_CHANNEL_ID')[0],
    roleIds: readIdList('SPRINT_ROLE_IDS'),
    voiceCategoryId: voiceCategoryId ? readIdList('SPRINT_VOICE_CATEGORY_ID')[0] : null,
    keywords: (readEnv('SPRINT_KEYWORDS') || DEFAULT_SPRINT_KEYWORDS)
      .split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean),
    organizerEmail: (readEnv('SPRINT_ORGANIZER_EMAIL') || '').toLowerCase() || null,
    remindTime: readTime('SPRINT_REMIND_TIME', DEFAULT_SPRINT_REMIND_TIME),
    pollIntervalMinutes: readPositiveInt(
      'SPRINT_POLL_INTERVAL_MINUTES',
      DEFAULT_SPRINT_POLL_INTERVAL_MINUTES
    ),
    timeZone: VIETNAM_TIME_ZONE,
  };
}

function assertNoRenamedEnv() {
  const renamed = Object.keys(RENAMED_ENV).filter((oldName) => oldName in process.env);

  if (renamed.length) {
    const lines = renamed.map((oldName) => `  ${oldName} -> ${RENAMED_ENV[oldName]}`);

    throw new Error(`Rename these env variables in .env:\n${lines.join('\n')}`);
  }
}

function readEnv(name) {
  const value = process.env[name];

  return value && value.trim() ? value.trim() : null;
}

function readRequiredEnv(name) {
  const value = readEnv(name);

  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }

  return value;
}

// Danh sách Discord id cách nhau bằng dấu phẩy.
function readIdList(name) {
  const ids = readRequiredEnv(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const id of ids) {
    if (!/^\d+$/.test(id)) {
      throw new Error(`Invalid ${name} value: ${id}. Expected comma-separated Discord ids`);
    }
  }

  if (!ids.length) {
    throw new Error(`${name} must contain at least one Discord id`);
  }

  return [...new Set(ids)];
}

function readTime(name, defaultValue) {
  const value = readEnv(name) || defaultValue;

  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`Invalid ${name} value: ${value}. Expected HH:mm, for example 08:00`);
  }

  return value;
}

function readPositiveInt(name, defaultValue) {
  const value = readEnv(name);

  if (!value) {
    return defaultValue;
  }

  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`Invalid ${name} value: ${value}. Expected a positive integer`);
  }

  return Number(value);
}

module.exports = { loadConfig };
