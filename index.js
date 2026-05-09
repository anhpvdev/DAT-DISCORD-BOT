require('dotenv').config();

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const VIETNAM_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const SCHEDULER_INTERVAL_MS = 20_000;
const PROMPT_CUSTOM_ID_PREFIX = 'daily_report_open';
const MODAL_CUSTOM_ID_PREFIX = 'daily_report_submit';
const DEFAULT_REPORT_START_TIME = '08:00';
const DEFAULT_REPORT_END_TIME = '17:00';
const DEFAULT_REPORT_DURATION_MINUTES = 60;
const VIETNAM_UTC_OFFSET_MINUTES = 7 * 60;

const REPORT_DEFINITIONS = [
  {
    type: 'start',
    displayName: 'report đầu ngày',
    envName: 'REPORT_START_TIME',
    aliases: ['DAILY_REPORT_START_TIME', 'START_REPORT_TIME', 'REPORT_START_AT'],
    defaultTime: DEFAULT_REPORT_START_TIME,
    modalTitle: 'Daily report đầu ngày',
    summaryTitle: 'Đã gửi form report đầu ngày',
    submitTitle: 'Daily report đầu ngày mới',
    buttonLabel: 'Gửi report đầu ngày',
    color: 0x2f80ed,
    fields: [
      {
        id: 'today',
        prompt: 'Ngày hôm nay của bạn thế nào?',
        label: 'Ngày hôm nay của bạn thế nào?',
        embedName: 'Ngày hôm nay',
      },
      {
        id: 'planned',
        prompt: 'Hôm nay bạn sẽ làm những công việc gì?',
        label: 'Hôm nay bạn sẽ làm những việc gì?',
        embedName: 'Công việc hôm nay',
      },
      {
        id: 'blockers',
        prompt: 'Bạn có gặp vướng mắc hay cần hỗ trợ gì không?',
        label: 'Bạn có vướng mắc/cần hỗ trợ không?',
        embedName: 'Vướng mắc / cần hỗ trợ',
        required: false,
        fallbackValue: 'Không có',
      },
    ],
  },
  {
    type: 'end',
    displayName: 'report cuối ngày',
    envName: 'REPORT_END_TIME',
    aliases: ['DAILY_REPORT_END_TIME', 'END_REPORT_TIME', 'REPORT_END_AT'],
    defaultTime: DEFAULT_REPORT_END_TIME,
    modalTitle: 'Daily report cuối ngày',
    summaryTitle: 'Đã gửi form report cuối ngày',
    submitTitle: 'Daily report cuối ngày mới',
    buttonLabel: 'Gửi report cuối ngày',
    color: 0x22a06b,
    fields: [
      {
        id: 'completed',
        prompt: 'Ngày hôm nay bạn đã hoàn thành những công việc gì?',
        label: 'Bạn đã hoàn thành việc gì?',
        embedName: 'Đã hoàn thành',
      },
      {
        id: 'next',
        prompt: 'Dự định tiếp theo của bạn là gì?',
        label: 'Dự định tiếp theo của bạn là gì?',
        embedName: 'Dự định tiếp theo',
      },
      {
        id: 'blockers',
        prompt: 'Bạn có gặp vướng mắc hay cần hỗ trợ gì không?',
        label: 'Bạn có vướng mắc/cần hỗ trợ không?',
        embedName: 'Vướng mắc / cần hỗ trợ',
        required: false,
        fallbackValue: 'Không có',
      },
    ],
  },
];

const REPORT_DEFINITIONS_BY_TYPE = new Map(
  REPORT_DEFINITIONS.map((report) => [report.type, report])
);

const config = {
  token: readEnv('DISCORD_TOKEN'),
  guildIds: parseIdList(readEnv('GUILD_IDS', ['GUILD_ID']), 'GUILD_IDS'),
  roleIds: parseIdList(
    readEnv('TARGET_ROLE_IDS', [
      'DAILY_REPORT_ROLE_IDS',
      'ROLE_IDS',
      'TARGET_ROLE_ID',
      'DAILY_REPORT_ROLE_ID',
      'ROLE_ID',
    ]),
    'TARGET_ROLE_IDS'
  ),
  reportChannelId: readEnv('REPORT_CHANNEL_ID'),
  reportDurationMinutes: readReportDurationMinutes(),
  reports: buildReportConfigs(),
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const sentScheduleKeys = new Set();
let schedulerTickRunning = false;

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Daily report timezone: ${VIETNAM_TIME_ZONE}`);
  console.log(`Configured guilds: ${config.guildIds.join(', ')}`);
  console.log(`Configured roles: ${config.roleIds.join(', ')}`);
  console.log(`Report duration: ${config.reportDurationMinutes} minutes`);
  console.log(
    `Daily report schedule: ${config.reports
      .map((report) => `${report.displayName} ${report.time}`)
      .join(', ')}`
  );
  startScheduler();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith(PROMPT_CUSTOM_ID_PREFIX)) {
      await handlePromptButton(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_CUSTOM_ID_PREFIX)) {
      await handleReportSubmit(interaction);
    }
  } catch (error) {
    console.error('Failed to handle interaction:', error);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Không thể xử lý report lúc này. Vui lòng thử lại sau.',
        flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined,
      });
    }
  }
});

client.login(config.token);

function readOptionalEnv(name, aliases = []) {
  const keys = [name, ...aliases];
  const foundKey = keys.find((key) => process.env[key] && process.env[key].trim());

  return foundKey ? process.env[foundKey].trim() : null;
}

function readEnv(name, aliases = []) {
  const value = readOptionalEnv(name, aliases);

  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }

  return value;
}

function parseIdList(value, envName) {
  const ids = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!ids.length) {
    throw new Error(`${envName} must contain at least one Discord id`);
  }

  for (const id of ids) {
    if (!/^\d+$/.test(id)) {
      throw new Error(`Invalid ${envName} value: ${id}. Expected comma-separated Discord ids`);
    }
  }

  return [...new Set(ids)];
}

function readReportDurationMinutes() {
  const value = readOptionalEnv('REPORT_DURATION', [
    'REPORT_DURATION_MINUTES',
    'DAILY_REPORT_DURATION',
    'DAILY_REPORT_DURATION_MINUTES',
  ]);

  if (!value) {
    return DEFAULT_REPORT_DURATION_MINUTES;
  }

  return parseReportDurationMinutes(value, 'REPORT_DURATION');
}

function parseReportDurationMinutes(value, envName) {
  const normalized = value.trim().toLowerCase();
  let durationMinutes;

  if (/^\d+$/.test(normalized)) {
    durationMinutes = Number(normalized);
  } else {
    const match = normalized.match(
      /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/
    );

    if (match) {
      const amount = Number(match[1]);
      const unit = match[2];
      durationMinutes = unit.startsWith('h') ? amount * 60 : amount;
    }
  }

  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new Error(
      `Invalid ${envName} value: ${value}. Expected minutes, for example 60, 60m, or 1h`
    );
  }

  const roundedDurationMinutes = Math.round(durationMinutes);

  if (roundedDurationMinutes !== durationMinutes) {
    throw new Error(`Invalid ${envName} value: ${value}. Duration must resolve to whole minutes`);
  }

  return roundedDurationMinutes;
}

function buildReportConfigs() {
  return REPORT_DEFINITIONS.map((report) => ({
    ...report,
    time: readReportTime(report.envName, report.aliases, report.defaultTime),
  }));
}

function readReportTime(envName, aliases, defaultTime) {
  return parseReportTime(readOptionalEnv(envName, aliases) || defaultTime, envName);
}

function parseReportTime(value, envName) {
  if (!isReportTime(value)) {
    throw new Error(`Invalid ${envName} value: ${value}. Expected HH:mm, for example 08:00`);
  }

  return value;
}

function isReportTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function getReportDefinition(reportType) {
  return REPORT_DEFINITIONS_BY_TYPE.get(reportType) || null;
}

function startScheduler() {
  runSchedulerTickSafely();
  setInterval(runSchedulerTickSafely, SCHEDULER_INTERVAL_MS);
}

async function runSchedulerTickSafely() {
  if (schedulerTickRunning) {
    return;
  }

  schedulerTickRunning = true;

  try {
    await runSchedulerTick();
  } catch (error) {
    handleSchedulerError(error);
  } finally {
    schedulerTickRunning = false;
  }
}

async function runSchedulerTick() {
  const vietnamTime = getVietnamTimeParts();

  if (!isVietnamBusinessDay(vietnamTime.date)) {
    pruneScheduleKeys(vietnamTime.date);
    return;
  }

  const dueReports = config.reports.filter((report) => report.time === vietnamTime.time);

  if (!dueReports.length) {
    return;
  }

  for (const report of dueReports) {
    const scheduleKey = `${vietnamTime.date}|${report.type}|${report.time}`;

    if (sentScheduleKeys.has(scheduleKey)) {
      continue;
    }

    sentScheduleKeys.add(scheduleKey);
    pruneScheduleKeys(vietnamTime.date);

    console.log(`Sending ${report.displayName} prompts for ${scheduleKey} (${VIETNAM_TIME_ZONE})`);
    await sendDailyReportPrompts(report, vietnamTime.date, vietnamTime.time);
  }
}

function handleSchedulerError(error) {
  console.error('Daily report scheduler failed:', error);
}

function getVietnamTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VIETNAM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function getReportWindow(reportDate, reportTime) {
  const startAt = getVietnamDateTimeAsUtcDate(reportDate, reportTime);
  const endAt = new Date(startAt.getTime() + config.reportDurationMinutes * 60_000);

  return { startAt, endAt };
}

function getVietnamDateTimeAsUtcDate(reportDate, reportTime) {
  const [year, month, day] = reportDate.split('-').map(Number);
  const [hour, minute] = reportTime.split(':').map(Number);

  return new Date(
    Date.UTC(year, month - 1, day, hour, minute) - VIETNAM_UTC_OFFSET_MINUTES * 60_000
  );
}

function isReportWindowOpen(reportDate, reportTime, date = new Date()) {
  const { startAt, endAt } = getReportWindow(reportDate, reportTime);

  return date >= startAt && date <= endAt;
}

function isVietnamBusinessDay(reportDate) {
  const [year, month, day] = reportDate.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

function buildExpiredReportMessage(report, reportDate, reportTime) {
  const { endAt } = getReportWindow(reportDate, reportTime);

  return [
    `Đã hết hạn gửi ${report.displayName} ngày ${formatVietnamDate(reportDate)}.`,
    `Hạn cuối: ${formatVietnamDateTime(endAt)} theo giờ Việt Nam.`,
  ].join('\n');
}

function formatVietnamDateTime(date) {
  const vietnamTime = getVietnamTimeParts(date);

  return `${vietnamTime.time} ngày ${formatVietnamDate(vietnamTime.date)}`;
}

function pruneScheduleKeys(currentDate) {
  for (const key of sentScheduleKeys) {
    if (!key.startsWith(`${currentDate}|`)) {
      sentScheduleKeys.delete(key);
    }
  }
}

async function sendDailyReportPrompts(report, reportDate, reportTime) {
  const results = [];

  for (const guildId of config.guildIds) {
    try {
      results.push(await sendDailyReportPromptsForGuild(report, guildId, reportDate, reportTime));
    } catch (error) {
      console.error(`Failed to send ${report.displayName} prompts for guild ${guildId}:`, error);
      results.push({ guildId, error });
    }
  }

  await sendPromptSummary(report, reportDate, reportTime, results);
}

async function sendDailyReportPromptsForGuild(report, guildId, reportDate, reportTime) {
  const guild = await client.guilds.fetch(guildId);
  const { roles, missingRoleIds, failedRoleFetches } = await fetchTargetRoles(guild);
  const members = new Map();

  if (roles.length) {
    await guild.members.fetch();

    for (const role of roles) {
      for (const member of role.members.values()) {
        if (!member.user.bot) {
          members.set(member.id, member);
        }
      }
    }
  }

  const button = new ButtonBuilder()
    .setCustomId(buildPromptCustomId(report.type, guildId, reportDate, reportTime))
    .setLabel(report.buttonLabel)
    .setStyle(ButtonStyle.Primary);

  const components = [new ActionRowBuilder().addComponents(button)];
  const content = buildPromptContent(report, reportDate);
  let sentCount = 0;
  const failedMembers = [];

  for (const member of members.values()) {
    try {
      await member.send({ content, components });
      sentCount += 1;
    } catch (error) {
      failedMembers.push(member);
      console.warn(`Cannot DM ${member.user.tag} (${member.id}): ${error.message}`);
    }
  }

  return {
    guild,
    roles,
    missingRoleIds,
    failedRoleFetches,
    memberCount: members.size,
    sentCount,
    failedMembers,
  };
}

async function fetchTargetRoles(guild) {
  const roles = [];
  const missingRoleIds = [];
  const failedRoleFetches = [];

  for (const roleId of config.roleIds) {
    try {
      const role = await guild.roles.fetch(roleId);

      if (role) {
        roles.push(role);
      } else {
        missingRoleIds.push(roleId);
      }
    } catch (error) {
      failedRoleFetches.push({ roleId, error });
      console.warn(`Cannot fetch role ${roleId} in guild ${guild.id}: ${error.message}`);
    }
  }

  return { roles, missingRoleIds, failedRoleFetches };
}

function buildPromptContent(report, reportDate) {
  return [
    `[DAT-Daily Report] ${report.displayName} ngày ${formatVietnamDate(reportDate)}`,
    'Bấm nút dưới đây để điền report.',
  ].join('\n');
}

async function sendPromptSummary(report, reportDate, reportTime, results) {
  const channel = await getReportChannel();
  const sentCount = results.reduce((total, result) => total + (result.sentCount || 0), 0);
  const memberCount = results.reduce((total, result) => total + (result.memberCount || 0), 0);
  const failedMemberCount = results.reduce(
    (total, result) => total + (result.failedMembers ? result.failedMembers.length : 0),
    0
  );
  const failedCount = failedMemberCount + results.filter((result) => result.error).length;
  const fields = [
    { name: 'Ngày', value: formatVietnamDate(reportDate), inline: true },
    {
      name: 'Hạn report',
      value: getVietnamTimeParts(getReportWindow(reportDate, reportTime).endAt).time,
      inline: true,
    },
    { name: 'Tổng member', value: String(memberCount), inline: true },
    { name: 'Đã gửi', value: String(sentCount), inline: true },
    { name: 'Lỗi', value: String(failedCount), inline: true },
    { name: 'Danh sách thất bại', value: truncate(formatFailedMembers(results), 1024) },
  ];

  const embed = new EmbedBuilder()
    .setTitle(report.summaryTitle)
    .setColor(report.color)
    .addFields(...fields);

  await channel.send({ embeds: [embed] });
}

function formatFailedMembers(results) {
  const lines = [];

  for (const result of results) {
    if (result.error) {
      lines.push(`${result.guildId}: ${result.error.message}`);
      continue;
    }

    if (!result.failedMembers.length) {
      continue;
    }

    for (const member of result.failedMembers) {
      lines.push(`${result.guild.name}: ${formatMemberDisplayName(member)}`);
    }
  }

  return lines.length ? lines.join('\n') : 'Không có';
}

async function handlePromptButton(interaction) {
  const payload = parseCustomId(interaction.customId, PROMPT_CUSTOM_ID_PREFIX);

  if (!payload) {
    await interaction.reply({
      content: 'Form daily report không hợp lệ. Vui lòng dùng link mới nhất từ bot.',
      flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined,
    });
    return;
  }

  const { report, guildId, reportDate, reportTime } = payload;

  if (!isReportWindowOpen(reportDate, reportTime)) {
    await interaction.reply({
      content: buildExpiredReportMessage(report, reportDate, reportTime),
      flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(buildModalCustomId(report.type, guildId, reportDate, reportTime))
    .setTitle(`${report.modalTitle} ${formatVietnamDate(reportDate)}`);
  const inputRows = report.fields.map((field) => {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label)
      .setPlaceholder(field.prompt)
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(field.required !== false)
      .setMaxLength(1000);

    return new ActionRowBuilder().addComponents(input);
  });

  modal.addComponents(...inputRows);

  await interaction.showModal(modal);
}

async function handleReportSubmit(interaction) {
  const payload = parseCustomId(interaction.customId, MODAL_CUSTOM_ID_PREFIX);

  if (!payload) {
    await interaction.reply({
      content: 'Report không hợp lệ. Vui lòng mở lại form từ tin nhắn của bot.',
      flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined,
    });
    return;
  }

  const { report, guildId, reportDate, reportTime } = payload;

  if (!isReportWindowOpen(reportDate, reportTime)) {
    await interaction.reply({
      content: buildExpiredReportMessage(report, reportDate, reportTime),
      flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined,
    });
    return;
  }

  const channel = await getReportChannel();
  const submitterName = await getGuildMemberDisplayName(guildId, interaction.user);
  const avatarURL = interaction.user.displayAvatarURL({ forceStatic: false });

  const embed = new EmbedBuilder()
    .setTitle(submitterName)
    .setColor(report.color)
    .setDescription(`${report.submitTitle} - ${formatVietnamDate(reportDate)}`)
    .setThumbnail(avatarURL);

  const reportFields = report.fields.map((field) => {
    const value = interaction.fields.getTextInputValue(field.id);

    return {
      name: `──────────────\n### ${field.embedName}`,
      value: truncate(value || field.fallbackValue, 1024),
      inline: false,
    };
  });

  embed.addFields(reportFields);

  await channel.send({ embeds: [embed] });

  await interaction.reply({
    content: `đã ghi nhận report ${report.displayName}`,
    flags: MessageFlags.Ephemeral,
  });

  // Thu hồi tin nhắn report cũ để tránh user gửi nhiều report
  if (interaction.message) {
    try {
      await interaction.message.delete();
    } catch (error) {
      console.warn('Không thể thu hồi tin nhắn report cũ:', error.message);
    }
  }
}

async function getGuildMemberDisplayName(guildId, user) {
  try {
    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId));
    const member = guild.members.cache.get(user.id) || (await guild.members.fetch(user.id));

    return formatMemberDisplayName(member);
  } catch (error) {
    console.warn(`Cannot fetch display name for ${user.tag} in guild ${guildId}: ${error.message}`);
    return formatUserDisplayName(user);
  }
}

function formatMemberDisplayName(member) {
  return member.displayName || formatUserDisplayName(member.user);
}

function formatUserDisplayName(user) {
  return user.globalName || user.username || user.tag;
}

async function getReportChannel() {
  const channel = await client.channels.fetch(config.reportChannelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error(`Report channel is not text-based or not found: ${config.reportChannelId}`);
  }

  return channel;
}

function buildPromptCustomId(reportType, guildId, reportDate, reportTime) {
  return `${PROMPT_CUSTOM_ID_PREFIX}|${reportType}|${guildId}|${reportDate}|${reportTime}`;
}

function buildModalCustomId(reportType, guildId, reportDate, reportTime) {
  return `${MODAL_CUSTOM_ID_PREFIX}|${reportType}|${guildId}|${reportDate}|${reportTime}`;
}

function parseCustomId(customId, prefix) {
  const parts = customId.split('|');

  if (parts.length !== 5) {
    return null;
  }

  const [actualPrefix, reportType, guildId, reportDate, reportTime] = parts;
  const report = getReportDefinition(reportType);

  if (
    actualPrefix !== prefix ||
    !report ||
    !/^\d+$/.test(guildId || '') ||
    !isReportDate(reportDate || '') ||
    !isReportTime(reportTime || '')
  ) {
    return null;
  }

  return { report, guildId, reportDate, reportTime };
}

function isReportDate(reportDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    return false;
  }

  const [year, month, day] = reportDate.split('-').map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));

  return (
    parsedDate.getUTCFullYear() === year &&
    parsedDate.getUTCMonth() === month - 1 &&
    parsedDate.getUTCDate() === day
  );
}

function formatVietnamDate(reportDate) {
  const [year, month, day] = reportDate.split('-');
  return `${day}/${month}/${year}`;
}

function truncate(value, maxLength) {
  const normalized = String(value || 'Không có').trim() || 'Không có';

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}
