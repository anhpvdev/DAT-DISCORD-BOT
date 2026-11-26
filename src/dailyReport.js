const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { normalizeText, truncate } = require('./utils');

const SCHEDULER_INTERVAL_MS = 20_000;
const PROMPT_CUSTOM_ID_PREFIX = 'daily_report_open';
const MODAL_CUSTOM_ID_PREFIX = 'daily_report_submit';
const PROMPT_CLEANUP_PAGE_SIZE = 100;
const RESEND_COMMAND_PREFIX = '/resend';
const EMPTY_VALUE = 'Không có';

const REPORT_DEFINITIONS = [
  {
    type: 'start',
    displayName: 'report đầu ngày',
    timeConfigKey: 'startTime',
    resendKeyword: 'sang',
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
        fallbackValue: EMPTY_VALUE,
      },
    ],
  },
  {
    type: 'end',
    displayName: 'report cuối ngày',
    timeConfigKey: 'endTime',
    resendKeyword: 'chieu',
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
        fallbackValue: EMPTY_VALUE,
      },
    ],
  },
];

const REPORT_DEFINITIONS_BY_TYPE = new Map(
  REPORT_DEFINITIONS.map((report) => [report.type, report])
);

let discordClient = null;
let settings = null;
let reports = [];
let schedulerTickRunning = false;
const sentScheduleKeys = new Set();

function start(client, dailyReportConfig) {
  discordClient = client;
  settings = dailyReportConfig;
  reports = REPORT_DEFINITIONS.map((report) => ({
    ...report,
    time: dailyReportConfig[report.timeConfigKey],
  }));

  console.log(`Daily report timezone: ${settings.timeZone}`);
  console.log(`Configured guilds: ${settings.guildIds.join(', ')}`);
  console.log(`Configured roles: ${settings.roleIds.join(', ')}`);
  console.log(
    `Daily report schedule: ${reports
      .map((report) => `${report.displayName} ${report.time}`)
      .join(', ')}`
  );

  runSchedulerTickSafely();
  setInterval(runSchedulerTickSafely, SCHEDULER_INTERVAL_MS);
}

// Trả về true nếu interaction thuộc về daily report (đã được xử lý).
async function handleInteraction(interaction) {
  if (interaction.isButton() && interaction.customId.startsWith(PROMPT_CUSTOM_ID_PREFIX)) {
    await handlePromptButton(interaction);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_CUSTOM_ID_PREFIX)) {
    await handleReportSubmit(interaction);
    return true;
  }

  return false;
}

// Lệnh `/resend sang` hoặc `/resend chieu` (gõ trong server) để nhận lại phiếu report qua DM.
async function handleMessage(message) {
  if (message.author.bot || !message.inGuild()) {
    return;
  }

  const botId = message.client.user.id;
  const command = [`<@${botId}>`, `<@!${botId}>`]
    .reduce((content, pattern) => content.replace(pattern, ' '), message.content)
    .trim();

  if (!command.toLowerCase().startsWith(RESEND_COMMAND_PREFIX)) {
    return;
  }

  const keyword = normalizeText(command.slice(RESEND_COMMAND_PREFIX.length));
  const report = reports.find((item) => item.resendKeyword === keyword);

  if (!report) {
    await message.reply('Dùng `/resend sang` hoặc `/resend chieu`.');
    return;
  }

  const reportDate = getVietnamTimeParts().date;
  const member = message.member || (await message.guild.members.fetch(message.author.id));

  await sendPromptToMember(
    member,
    buildPromptMessage(report, message.guild.id, reportDate, report.time)
  );
  await message.reply(`Đã gửi lại phiếu ${report.displayName} vào DM của bạn.`);
}

async function runSchedulerTickSafely() {
  if (schedulerTickRunning) {
    return;
  }

  schedulerTickRunning = true;

  try {
    await runSchedulerTick();
  } catch (error) {
    console.error('Daily report scheduler failed:', error);
  } finally {
    schedulerTickRunning = false;
  }
}

async function runSchedulerTick() {
  const vietnamTime = getVietnamTimeParts();

  if (!isBusinessDay(vietnamTime.date)) {
    pruneScheduleKeys(vietnamTime.date);
    return;
  }

  const dueReports = reports.filter((report) => report.time === vietnamTime.time);

  for (const report of dueReports) {
    const scheduleKey = `${vietnamTime.date}|${report.type}|${report.time}`;

    if (sentScheduleKeys.has(scheduleKey)) {
      continue;
    }

    sentScheduleKeys.add(scheduleKey);
    pruneScheduleKeys(vietnamTime.date);

    console.log(`Sending ${report.displayName} prompts for ${scheduleKey} (${settings.timeZone})`);
    await sendDailyReportPrompts(report, vietnamTime.date, vietnamTime.time);
  }
}

function getVietnamTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: settings.timeZone,
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

function isBusinessDay(reportDate) {
  const [year, month, day] = reportDate.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return dayOfWeek >= 1 && dayOfWeek <= 5;
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

  for (const guildId of settings.guildIds) {
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
  const guild = await discordClient.guilds.fetch(guildId);
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

  const promptMessage = buildPromptMessage(report, guildId, reportDate, reportTime);
  let sentCount = 0;
  let deletedPromptCount = 0;
  const failedMembers = [];

  const { reportType, ...message } = promptMessage;

  for (const member of members.values()) {
    try {
      const dmChannel = await member.createDM();
      // Cộng ngay số phiếu cũ đã xóa, kể cả khi gửi phiếu mới thất bại.
      deletedPromptCount += await deleteExistingPromptMessages(dmChannel, reportType);
      await dmChannel.send(message);
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
    deletedPromptCount,
    failedMembers,
  };
}

function buildPromptMessage(report, guildId, reportDate, reportTime) {
  const button = new ButtonBuilder()
    .setCustomId(buildCustomId(PROMPT_CUSTOM_ID_PREFIX, report.type, guildId, reportDate, reportTime))
    .setLabel(report.buttonLabel)
    .setStyle(ButtonStyle.Primary);

  return {
    reportType: report.type,
    content: [
      `[DAT-Daily Report] ${report.displayName} ngày ${formatVietnamDate(reportDate)}`,
      'Bấm nút dưới đây để điền report.',
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(button)],
  };
}

// Xóa phiếu cũ cùng loại trong DM rồi gửi phiếu mới (dùng cho lệnh /resend).
async function sendPromptToMember(member, promptMessage) {
  const { reportType, ...message } = promptMessage;
  const dmChannel = await member.createDM();

  await deleteExistingPromptMessages(dmChannel, reportType);
  await dmChannel.send(message);
}

async function fetchTargetRoles(guild) {
  const roles = [];
  const missingRoleIds = [];
  const failedRoleFetches = [];

  for (const roleId of settings.roleIds) {
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

async function deleteExistingPromptMessages(dmChannel, reportType) {
  let deletedCount = 0;
  let before;

  while (true) {
    let messages;

    try {
      const fetchOptions = { limit: PROMPT_CLEANUP_PAGE_SIZE };

      if (before) {
        fetchOptions.before = before;
      }

      messages = await dmChannel.messages.fetch(fetchOptions);
    } catch (error) {
      console.warn(
        `Cannot fetch old ${reportType} prompts in DM ${dmChannel.id}: ${error.message}`
      );
      return deletedCount;
    }

    if (!messages.size) {
      return deletedCount;
    }

    before = messages.last().id;

    for (const message of messages.values()) {
      const isOldPrompt =
        message.author.id === discordClient.user.id &&
        getPromptMessageReportType(message) === reportType;

      if (!isOldPrompt) {
        continue;
      }

      try {
        await message.delete();
        deletedCount += 1;
      } catch (error) {
        console.warn(`Cannot delete old ${reportType} prompt ${message.id}: ${error.message}`);
      }
    }

    if (messages.size < PROMPT_CLEANUP_PAGE_SIZE) {
      return deletedCount;
    }
  }
}

function getPromptMessageReportType(message) {
  for (const row of message.components || []) {
    for (const component of row.components || []) {
      if (typeof component.customId !== 'string') {
        continue;
      }

      const payload = parseCustomId(component.customId, PROMPT_CUSTOM_ID_PREFIX);

      if (payload) {
        return payload.report.type;
      }
    }
  }

  return null;
}

async function sendPromptSummary(report, reportDate, reportTime, results) {
  const channel = await getReportChannel();
  const sum = (pick) => results.reduce((total, result) => total + (pick(result) || 0), 0);
  const failedCount =
    sum((result) => result.failedMembers && result.failedMembers.length) +
    results.filter((result) => result.error).length;

  const embed = new EmbedBuilder()
    .setTitle(report.summaryTitle)
    .setColor(report.color)
    .addFields(
      { name: 'Ngày', value: formatVietnamDate(reportDate), inline: true },
      { name: 'Giờ gửi', value: reportTime, inline: true },
      { name: 'Tổng member', value: String(sum((result) => result.memberCount)), inline: true },
      { name: 'Đã gửi', value: String(sum((result) => result.sentCount)), inline: true },
      {
        name: 'Đã xóa prompt cũ',
        value: String(sum((result) => result.deletedPromptCount)),
        inline: true,
      },
      { name: 'Lỗi', value: String(failedCount), inline: true },
      { name: 'Danh sách thất bại', value: formatFieldValue(formatFailedMembers(results)) }
    );

  await channel.send({ embeds: [embed] });
}

function formatFailedMembers(results) {
  const lines = [];

  for (const result of results) {
    if (result.error) {
      lines.push(`${result.guildId}: ${result.error.message}`);
      continue;
    }

    for (const member of result.failedMembers) {
      lines.push(`${result.guild.name}: ${formatMemberDisplayName(member)}`);
    }
  }

  return lines.length ? lines.join('\n') : EMPTY_VALUE;
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

  const modal = new ModalBuilder()
    .setCustomId(buildCustomId(MODAL_CUSTOM_ID_PREFIX, report.type, guildId, reportDate, reportTime))
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

  const { report, guildId, reportDate } = payload;

  const channel = await getReportChannel();
  const submitterName = await getGuildMemberDisplayName(guildId, interaction.user);
  const avatarURL = interaction.user.displayAvatarURL({ forceStatic: false });

  const embed = new EmbedBuilder()
    .setTitle(submitterName)
    .setColor(report.color)
    .setDescription(`${report.submitTitle} - ${formatVietnamDate(reportDate)}`)
    .setThumbnail(avatarURL)
    .addFields(
      report.fields.map((field) => ({
        name: `──────────────\n### ${field.embedName}`,
        value: formatFieldValue(interaction.fields.getTextInputValue(field.id) || field.fallbackValue),
        inline: false,
      }))
    );

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
    const guild =
      discordClient.guilds.cache.get(guildId) || (await discordClient.guilds.fetch(guildId));
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
  const channel = await discordClient.channels.fetch(settings.channelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error(`Report channel is not text-based or not found: ${settings.channelId}`);
  }

  return channel;
}

function buildCustomId(prefix, reportType, guildId, reportDate, reportTime) {
  return `${prefix}|${reportType}|${guildId}|${reportDate}|${reportTime}`;
}

function parseCustomId(customId, prefix) {
  const parts = customId.split('|');

  if (parts.length !== 5) {
    return null;
  }

  const [actualPrefix, reportType, guildId, reportDate, reportTime] = parts;
  const report = REPORT_DEFINITIONS_BY_TYPE.get(reportType);

  if (
    actualPrefix !== prefix ||
    !report ||
    !/^\d+$/.test(guildId || '') ||
    !isReportDate(reportDate || '') ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reportTime || '')
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

// Giá trị cho embed field: không được rỗng và tối đa 1024 ký tự.
function formatFieldValue(value) {
  return truncate(String(value || EMPTY_VALUE).trim() || EMPTY_VALUE, 1024);
}

module.exports = {
  start,
  handleInteraction,
  handleMessage,
};
