const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { normalizeText, truncate } = require('./utils');

// File nằm ở <project>/data để khớp với volume ./data trong docker-compose.
const STATE_FILE = path.join(__dirname, '..', 'data', 'meeting-notified.json');
const STATE_RETENTION_MS = 24 * 60 * 60 * 1000;
const STATE_MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Giờ Việt Nam cố định UTC+7, không có DST.
const VIETNAM_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const COLOR_UPCOMING = 0xf2994a;
const COLOR_SOON = 0xeb5757;
const SOON_THRESHOLD_MS = 60 * 60 * 1000;
const RSVP_CUSTOM_ID_PREFIX = 'meeting_rsvp';
const BUSY_MODAL_CUSTOM_ID = 'meeting_busy_submit';
const BUSY_REASON_INPUT_ID = 'reason';
const BUSY_REASON_MAX_LENGTH = 100;
const MESSAGE_CONTENT_MAX_LENGTH = 2000;
const EMBED_FIELD_MAX_LENGTH = 1024;
const VOICE_CHANNEL_NAME_MAX_LENGTH = 100;
const UNKNOWN_CHANNEL_ERROR_CODE = 10003;
const UNKNOWN_MESSAGE_ERROR_CODE = 10008;
const MAX_EMBEDS_PER_MESSAGE = 10;
const ATTENDEE_STATUS_ORDER = { going: 0, busy: 1, waiting: 2 };
const ATTENDEE_STATUS_STYLES = {
  going: { color: 0x3ba55d, label: '✅ Tham gia' },
  busy: { color: 0xed4245, label: '⛔ Báo bận' },
  waiting: { color: 0x4e5058, label: '⏳ Chưa phản hồi' },
};

let icalPromise = null;
let tickRunning = false;
let settings = null;
let discordClient = null;
// key `${uid}|${startMs}` -> record. Mỗi lần diễn ra của một lịch chỉ được thông báo 1 lần.
let records = new Map();
// messageId -> promise của lần sửa tin nhắn gần nhất.
const messageUpdateQueues = new Map();

function start(client, sprintConfig) {
  settings = sprintConfig;
  discordClient = client;
  records = loadState();

  console.log(
    `Sprint notifier: channel ${settings.notifyChannelId}, roles ${settings.roleIds.join(', ')}, remind at ${settings.remindTime}, keywords ${settings.keywords.join(' | ')}, poll every ${settings.pollIntervalMinutes} minutes`
  );

  const tick = () => runTickSafely(client);

  // Chạy ngay khi khởi động: lịch nào còn dưới ngưỡng nhắc mà chưa báo sẽ được báo luôn.
  tick();
  setInterval(tick, settings.pollIntervalMinutes * 60 * 1000);
}

async function runTickSafely(client) {
  if (tickRunning) {
    return;
  }

  tickRunning = true;

  try {
    await cleanupExpiredRooms(client, Date.now());
  } catch (error) {
    console.error(`Meeting room cleanup failed: ${error.message}`);
  }

  try {
    await retryMissingRooms(client, Date.now());
  } catch (error) {
    console.error(`Meeting room retry failed: ${error.message}`);
  }

  try {
    await notifyDueMeetings(client);
  } catch (error) {
    // Chỉ log message, không log URL vì link iCal là bí mật.
    console.error(`Meeting notifier failed: ${error.message}`);
  } finally {
    tickRunning = false;
  }
}

async function notifyDueMeetings(client) {
  const now = Date.now();
  const dueMeetings = await findDueMeetings(settings, now);
  const pending = dueMeetings.filter((meeting) => !records.has(meeting.key));

  if (!pending.length) {
    return;
  }

  const channel = await client.channels.fetch(settings.notifyChannelId);

  if (!channel || !channel.isTextBased() || !channel.guild) {
    throw new Error(`Sprint notify channel is not a guild text channel: ${settings.notifyChannelId}`);
  }

  const { roleIds, memberIds } = await fetchInvitedMembers(channel.guild, settings.roleIds);

  for (const meeting of pending) {
    const record = {
      title: meeting.title,
      startMs: meeting.startMs,
      endMs: meeting.endMs,
      guildId: channel.guild.id,
      channelId: channel.id,
      messageId: null,
      voiceChannelId: null,
      roomError: null,
      deleteAtMs: getVietnamEndOfDay(meeting.startMs),
      roleIds,
      invited: memberIds,
      rsvp: {},
    };
    const room = await createMeetingRoom(client, channel, record);

    try {
      const message = await channel.send(await buildMeetingMessage(record));

      record.messageId = message.id;
    } catch (error) {
      if (room) {
        await room.delete('Meeting notification failed').catch(() => { });
      }

      throw error;
    }

    records.set(meeting.key, record);
    saveState(now);
    console.log(
      `Sent meeting notification: "${meeting.title}" at ${new Date(meeting.startMs).toISOString()}`
    );
  }
}

async function fetchInvitedMembers(guild, configuredRoleIds) {
  const roleIds = [];
  const memberIds = new Set();

  await guild.members.fetch();

  for (const roleId of configuredRoleIds) {
    const role = await guild.roles.fetch(roleId).catch(() => null);

    if (!role) {
      console.warn(`Meeting role ${roleId} not found in guild ${guild.id}`);
      continue;
    }

    roleIds.push(role.id);

    for (const member of role.members.values()) {
      if (!member.user.bot) {
        memberIds.add(member.id);
      }
    }
  }

  return { roleIds, memberIds: [...memberIds] };
}

// Phòng họp nằm trong category được cấu hình; nếu không cấu hình thì cùng category với channel thông báo.
async function resolveRoomParentId(client, textChannel) {
  if (!settings.voiceCategoryId) {
    return textChannel.isThread() ? textChannel.parent?.parentId : textChannel.parentId;
  }

  const target = await client.channels.fetch(settings.voiceCategoryId);

  // Nếu id là một channel thường thì đặt phòng họp cùng category với channel đó.
  return target.type === ChannelType.GuildCategory ? target.id : target.parentId;
}

async function createMeetingRoom(client, textChannel, record) {
  const guild = textChannel.guild;
  // Chỉ dùng View + Connect: Discord chỉ cho bot cấp những quyền mà chính bot đang có.
  const accessPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect];

  try {
    const parentId = await resolveRoomParentId(client, textChannel);
    const room = await guild.channels.create({
      name: truncate(record.title, VOICE_CHANNEL_NAME_MAX_LENGTH),
      type: ChannelType.GuildVoice,
      parent: parentId || undefined,
      reason: `Meeting room for "${record.title}"`,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
        },
        ...record.roleIds.map((roleId) => ({ id: roleId, allow: accessPermissions })),
        { id: client.user.id, allow: accessPermissions },
      ],
    });

    record.voiceChannelId = room.id;
    record.roomError = null;
    return room;
  } catch (error) {
    // Vẫn gửi thông báo dù không tạo được phòng (thường do bot thiếu quyền Manage Channels).
    // Bot sẽ thử tạo lại ở các lần quét sau.
    if (record.roomError !== error.message) {
      console.warn(`Cannot create meeting room for "${record.title}": ${error.message}`);
    }

    record.roomError = error.message;
    return null;
  }
}

// Thông báo đã gửi nhưng chưa có phòng (ví dụ bot vừa được cấp quyền): tạo phòng và cập nhật thông báo.
async function retryMissingRooms(client, now) {
  let changed = false;

  for (const record of records.values()) {
    if (!record.messageId || record.voiceChannelId || record.deleteAtMs <= now) {
      continue;
    }

    const channel = await client.channels.fetch(record.channelId).catch(() => null);

    if (!channel || !channel.guild) {
      continue;
    }

    if (await createMeetingRoom(client, channel, record)) {
      changed = true;
      console.log(`Created meeting room for "${record.title}" on retry`);
      await refreshMeetingMessage(client, record);
    }
  }

  if (changed) {
    saveState(now);
  }
}

async function cleanupExpiredRooms(client, now) {
  let changed = false;

  for (const record of records.values()) {
    if (!record.voiceChannelId || record.deleteAtMs > now) {
      continue;
    }

    try {
      const room = await client.channels.fetch(record.voiceChannelId);

      await room.delete('Meeting room expired');
      console.log(`Deleted expired meeting room for "${record.title}"`);
    } catch (error) {
      if (error.code !== UNKNOWN_CHANNEL_ERROR_CODE) {
        console.warn(`Cannot delete meeting room for "${record.title}": ${error.message}`);
        continue;
      }
    }

    record.voiceChannelId = null;
    changed = true;
    await refreshMeetingMessage(client, record);
  }

  if (changed) {
    saveState(now);
  }
}

// Các lần sửa cùng một thông báo chạy lần lượt và luôn dựng nội dung từ trạng thái mới nhất,
// để 2 người bấm nút cùng lúc không làm bản cũ ghi đè bản mới.
function enqueueMessageUpdate(messageId, update) {
  const previous = messageUpdateQueues.get(messageId) || Promise.resolve();
  const next = previous.then(update, update);
  const cleanup = () => {
    if (messageUpdateQueues.get(messageId) === next) {
      messageUpdateQueues.delete(messageId);
    }
  };

  messageUpdateQueues.set(messageId, next);
  next.then(cleanup, cleanup);
  return next;
}

async function refreshMeetingMessage(client, record) {
  if (!record.messageId) {
    return;
  }

  try {
    const channel = await client.channels.fetch(record.channelId);
    const message = await channel.messages.fetch(record.messageId);

    await enqueueMessageUpdate(record.messageId, async () =>
      message.edit(await buildMeetingMessage(record))
    );
  } catch (error) {
    if (error.code !== UNKNOWN_MESSAGE_ERROR_CODE && error.code !== UNKNOWN_CHANNEL_ERROR_CODE) {
      console.warn(`Cannot update meeting message for "${record.title}": ${error.message}`);
    }
  }
}

async function findDueMeetings(sprintConfig, now) {
  const ical = await loadIcal();
  const calendar = ical.sync.parseICS(await fetchCalendarText(sprintConfig.icsUrl));
  // Lịch đến hạn nhắc luôn bắt đầu trong vòng 24 giờ tới (xem getRemindAtMs).
  const windowEnd = now + DAY_MS;
  const meetings = [];

  for (const component of Object.values(calendar)) {
    if (!component || component.type !== 'VEVENT') {
      continue;
    }

    let instances;

    try {
      instances = ical.expandRecurringEvent(component, {
        from: new Date(now),
        to: new Date(windowEnd),
      });
    } catch (error) {
      console.warn(`Cannot expand calendar event ${component.uid}: ${error.message}`);
      continue;
    }

    for (const instance of instances) {
      const event = instance.event || component;
      const startMs = instance.start.getTime();

      // Chưa đến giờ nhắc thì bỏ qua. Bot khởi động muộn hơn giờ nhắc thì lịch chưa báo được báo ngay.
      if (instance.isFullDay || startMs <= now || getRemindAtMs(startMs, sprintConfig.remindTime) > now) {
        continue;
      }

      if (String(event.status || '').toUpperCase() === 'CANCELLED') {
        continue;
      }

      if (!matchesFilters(event, sprintConfig)) {
        continue;
      }

      meetings.push({
        key: `${component.uid}|${startMs}`,
        title: textOf(event.summary).trim() || '(Không có tiêu đề)',
        startMs,
        endMs: instance.end.getTime(),
      });
    }
  }

  return meetings.sort((a, b) => a.startMs - b.startMs);
}

async function loadIcal() {
  if (!icalPromise) {
    // node-ical là ES module nên phải dùng dynamic import từ CommonJS.
    icalPromise = import('node-ical').then((module) => module.default);
  }

  return icalPromise;
}

async function fetchCalendarText(icsUrl) {
  let response;

  try {
    response = await fetch(icsUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Cannot fetch Google Calendar iCal feed (${error.name})`);
  }

  if (!response.ok) {
    throw new Error(`Google Calendar iCal feed responded with HTTP ${response.status}`);
  }

  return response.text();
}

// Title chứa từ khóa thì khớp. `*` trong từ khóa khớp chuỗi bất kỳ:
// `[WG] Sprint*#*` khớp "[WG] Sprint Planning #18", "[WG] Sprint Review #19"; riêng `*` khớp mọi lịch.
// Không phân biệt hoa thường và dấu.
function matchesKeyword(normalizedTitle, keyword) {
  const pattern = normalizeText(keyword)
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  return new RegExp(pattern).test(normalizedTitle);
}

function matchesFilters(event, sprintConfig) {
  const title = normalizeText(textOf(event.summary));

  if (!sprintConfig.keywords.some((keyword) => matchesKeyword(title, keyword))) {
    return false;
  }

  if (!sprintConfig.organizerEmail) {
    return true;
  }

  const organizerEmail = textOf(event.organizer)
    .replace(/^mailto:/i, '')
    .trim()
    .toLowerCase();

  return organizerEmail === sprintConfig.organizerEmail;
}

// Dòng content nằm ngoài embed vì mention trong embed không ping được.
function buildMentionContent(record) {
  const startUnix = Math.floor(record.startMs / 1000);
  const lines = [`📅 **${record.title}** — bắt đầu <t:${startUnix}:R>`];

  if (record.voiceChannelId) {
    lines.push(`🔊 **Phòng họp:** <#${record.voiceChannelId}>`);
  }

  if (!record.invited.length) {
    return lines.join('\n');
  }

  const memberMentions = record.invited.map((memberId) => `<@${memberId}>`).join(' ');
  const content = [...lines, `👥 **Người tham dự:** ${memberMentions}`].join('\n');

  if (content.length <= MESSAGE_CONTENT_MAX_LENGTH) {
    return content;
  }

  // Quá nhiều người để ping từng người trong 1 tin nhắn: ping theo role.
  const roleMentions = record.roleIds.map((id) => `<@&${id}>`).join(' ');

  return [...lines, `👥 **Người tham dự:** ${roleMentions}`].join('\n');
}

// Lấy tên hiển thị + avatar hiện tại của từng người để hiển thị danh sách tham dự.
async function resolveAttendees(record) {
  const guild = record.guildId
    ? await discordClient.guilds.fetch(record.guildId).catch(() => null)
    : null;
  const userIds = [...new Set([...record.invited, ...Object.keys(record.rsvp)])];

  return Promise.all(
    userIds.map(async (userId) => {
      const member = guild
        ? guild.members.cache.get(userId) || (await guild.members.fetch(userId).catch(() => null))
        : null;
      const response = record.rsvp[userId];

      return {
        name: member ? member.displayName : 'Thành viên đã rời server',
        avatarUrl: member ? member.displayAvatarURL({ size: 64 }) : null,
        status: response ? response.status : 'waiting',
        reason: response ? response.reason : '',
      };
    })
  );
}

// Mỗi người là 1 embed nhỏ: avatar + tên, màu viền theo trạng thái (xanh / đỏ / xám).
function buildAttendeeEmbeds(attendees) {
  return [...attendees]
    .sort((a, b) => ATTENDEE_STATUS_ORDER[a.status] - ATTENDEE_STATUS_ORDER[b.status])
    .map((attendee) => {
      const style = ATTENDEE_STATUS_STYLES[attendee.status];
      const status = attendee.status === 'busy' && attendee.reason
        ? `${style.label}: ${attendee.reason}`
        : style.label;

      return new EmbedBuilder().setColor(style.color).setAuthor({
        name: truncate(`${attendee.name}  ·  ${status}`, 256),
        iconURL: attendee.avatarUrl || undefined,
      });
    });
}

async function buildMeetingMessage(record) {
  const timeZone = settings.timeZone;
  const startUnix = Math.floor(record.startMs / 1000);
  const timeRange = `${formatTime(record.startMs, timeZone)} – ${formatTime(record.endMs, timeZone)}`;
  const isSoon = record.startMs - Date.now() <= SOON_THRESHOLD_MS;
  const roomExpired = record.deleteAtMs <= Date.now();
  const descriptionLines = [
    `## ⏰ ${timeRange}`,
    `**${formatDate(record.startMs, timeZone)}** · bắt đầu <t:${startUnix}:R>`,
  ];

  if (record.voiceChannelId) {
    descriptionLines.push('', `🔊 **Phòng họp:** <#${record.voiceChannelId}>`);
  } else if (roomExpired) {
    descriptionLines.push('', '🔒 Phòng họp đã đóng.');
  } else if (record.roomError) {
    descriptionLines.push(
      '',
      `⚠️ Chưa tạo được phòng họp (${record.roomError}). Bot cần quyền **Manage Channels** và sẽ tự thử lại.`
    );
  }

  const going = [];
  const busy = [];

  for (const [userId, response] of Object.entries(record.rsvp)) {
    if (response.status === 'going') {
      going.push(`<@${userId}>`);
    } else {
      busy.push(response.reason ? `<@${userId}> — ${response.reason}` : `<@${userId}>`);
    }
  }

  const waiting = record.invited
    .filter((memberId) => !record.rsvp[memberId])
    .map((memberId) => `<@${memberId}>`);

  const embed = new EmbedBuilder()
    .setColor(isSoon ? COLOR_SOON : COLOR_UPCOMING)
    .setTitle(truncate(`📅 ${record.title}`, 256))
    .setDescription(descriptionLines.join('\n'));
  const attendees = await resolveAttendees(record);
  const message = {
    content: buildMentionContent(record),
    allowedMentions: { parse: ['users', 'roles'] },
    embeds: [embed],
    components: [],
    // Khi sửa tin nhắn cũ: gỡ ảnh đính kèm của phiên bản trước.
    attachments: [],
  };

  if (attendees.length && attendees.length < MAX_EMBEDS_PER_MESSAGE) {
    message.embeds.push(...buildAttendeeEmbeds(attendees));
  } else {
    // Discord giới hạn 10 embed mỗi tin nhắn: đông người thì dùng danh sách dạng text.
    embed.addFields(
      { name: `✅ Tham gia (${going.length})`, value: formatList(going, ' ') },
      { name: `⛔ Báo bận (${busy.length})`, value: formatList(busy, '\n') },
      { name: `⏳ Chưa phản hồi (${waiting.length})`, value: formatList(waiting, ' ') }
    );
  }

  if (roomExpired) {
    return message;
  }

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`${RSVP_CUSTOM_ID_PREFIX}|going`)
      .setLabel('Xác nhận tham gia')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${RSVP_CUSTOM_ID_PREFIX}|busy`)
      .setLabel('Báo bận')
      .setEmoji('⛔')
      .setStyle(ButtonStyle.Danger),
  ];

  if (record.voiceChannelId && record.guildId) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Vào phòng họp')
        .setEmoji('🔊')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${record.guildId}/${record.voiceChannelId}`)
    );
  }

  message.components = [new ActionRowBuilder().addComponents(...buttons)];

  return message;
}

// Trả về true nếu interaction thuộc về thông báo lịch họp (đã được xử lý).
async function handleInteraction(interaction) {
  if (interaction.isButton() && interaction.customId.startsWith(`${RSVP_CUSTOM_ID_PREFIX}|`)) {
    const record = findRecordByMessageId(interaction.message.id);

    if (!record) {
      await replyExpired(interaction);
      return true;
    }

    if (interaction.customId.endsWith('|busy')) {
      await interaction.showModal(buildBusyModal());
      return true;
    }

    // Dựng lại thông báo cần gọi API (avatar, tên) nên defer trước để không quá hạn 3 giây.
    await interaction.deferUpdate();
    await saveRsvp(interaction, record, { status: 'going' });
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId === BUSY_MODAL_CUSTOM_ID) {
    const record = interaction.isFromMessage()
      ? findRecordByMessageId(interaction.message.id)
      : null;

    if (!record) {
      await replyExpired(interaction);
      return true;
    }

    const reason = interaction.fields
      .getTextInputValue(BUSY_REASON_INPUT_ID)
      .replace(/\s+/g, ' ')
      .trim();

    await interaction.deferUpdate();
    await saveRsvp(interaction, record, { status: 'busy', reason });
    return true;
  }

  return false;
}

async function saveRsvp(interaction, record, response) {
  record.rsvp[interaction.user.id] = response;
  saveState(Date.now());
  await enqueueMessageUpdate(record.messageId, async () =>
    interaction.editReply(await buildMeetingMessage(record))
  );
}

function buildBusyModal() {
  const reasonInput = new TextInputBuilder()
    .setCustomId(BUSY_REASON_INPUT_ID)
    .setLabel('Lý do bận (không bắt buộc)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(BUSY_REASON_MAX_LENGTH);

  return new ModalBuilder()
    .setCustomId(BUSY_MODAL_CUSTOM_ID)
    .setTitle('Báo bận')
    .addComponents(new ActionRowBuilder().addComponents(reasonInput));
}

async function replyExpired(interaction) {
  await interaction.reply({
    content: 'Lịch họp này đã hết hạn phản hồi.',
    flags: MessageFlags.Ephemeral,
  });
}

function findRecordByMessageId(messageId) {
  for (const record of records.values()) {
    if (record.messageId === messageId) {
      return record;
    }
  }

  return null;
}

function formatList(items, separator) {
  if (!items.length) {
    return '—';
  }

  const shown = [];
  let length = 0;

  for (const item of items) {
    // Chừa chỗ cho dòng "… và N người khác".
    if (length + item.length + separator.length > EMBED_FIELD_MAX_LENGTH - 30) {
      break;
    }

    shown.push(item);
    length += item.length + separator.length;
  }

  const hiddenCount = items.length - shown.length;

  return hiddenCount > 0
    ? `${shown.join(separator)}\n… và ${hiddenCount} người khác`
    : shown.join(separator);
}

// Giờ nhắc = SPRINT_REMIND_TIME trong ngày họp (giờ Việt Nam).
// Lịch bắt đầu trước giờ nhắc (ví dụ họp 09:00, nhắc 16:00) được nhắc từ hôm trước, cùng giờ nhắc.
function getRemindAtMs(startMs, remindTime) {
  const [hours, minutes] = remindTime.split(':').map(Number);
  const remindAtMs = getVietnamStartOfDay(startMs) + (hours * 60 + minutes) * 60 * 1000;

  return remindAtMs > startMs ? remindAtMs - DAY_MS : remindAtMs;
}

function getVietnamStartOfDay(timestampMs) {
  return getVietnamEndOfDay(timestampMs) - DAY_MS;
}

function getVietnamEndOfDay(timestampMs) {
  const vietnamDayIndex = Math.floor((timestampMs + VIETNAM_UTC_OFFSET_MS) / DAY_MS);

  return (vietnamDayIndex + 1) * DAY_MS - VIETNAM_UTC_OFFSET_MS;
}

function textOf(value) {
  if (value && typeof value === 'object') {
    return String(value.val || '');
  }

  return String(value || '');
}

function formatTime(timestampMs, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(timestampMs));
}

function formatDate(timestampMs, timeZone) {
  const parts = new Intl.DateTimeFormat('vi-VN', {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.weekday}, ${values.day}/${values.month}/${values.year}`;
}

function loadState() {
  try {
    const entries = Object.entries(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));

    return new Map(
      entries
        // Format cũ chỉ lưu startMs: giữ lại làm dấu "đã báo".
        .map(([key, value]) => [key, typeof value === 'number' ? { startMs: value } : value])
        .filter(([, record]) => record && Number.isFinite(record.startMs))
        .map(([key, record]) => [
          key,
          {
            title: '',
            endMs: record.startMs,
            guildId: null,
            channelId: null,
            messageId: null,
            voiceChannelId: null,
            roomError: null,
            deleteAtMs: getVietnamEndOfDay(record.startMs),
            roleIds: [],
            invited: [],
            rsvp: {},
            ...record,
          },
        ])
    );
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Cannot read meeting state file, starting empty: ${error.message}`);
    }

    return new Map();
  }
}

function saveState(now) {
  for (const [key, record] of records) {
    const age = now - record.startMs;

    // Giữ record còn phòng họp chưa xóa được, nhưng không giữ quá 7 ngày.
    if (age > STATE_MAX_RETENTION_MS || (age > STATE_RETENTION_MS && !record.voiceChannelId)) {
      records.delete(key);
    }
  }

  try {
    const tempFile = `${STATE_FILE}.tmp`;

    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(Object.fromEntries(records), null, 2));
    fs.renameSync(tempFile, STATE_FILE);
  } catch (error) {
    console.warn(`Cannot save meeting state file: ${error.message}`);
  }
}

module.exports = {
  start,
  handleInteraction,
  // Export để test thủ công.
  findDueMeetings,
};
