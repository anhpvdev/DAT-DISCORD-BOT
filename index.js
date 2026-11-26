require('dotenv').config();

const { Client, Events, GatewayIntentBits, MessageFlags, Partials } = require('discord.js');
const { loadConfig } = require('./src/config');
const dailyReport = require('./src/dailyReport');
const sprintNotifier = require('./src/sprintNotifier');

const config = loadConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);

  dailyReport.start(client, config.dailyReport);

  if (config.sprint) {
    sprintNotifier.start(client, config.sprint);
  } else {
    console.log('Sprint notifier disabled: SPRINT_CALENDAR_ICS_URL is not set');
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Mỗi module tự nhận diện interaction của mình qua customId và trả về true nếu đã xử lý.
    if (await sprintNotifier.handleInteraction(interaction)) {
      return;
    }

    await dailyReport.handleInteraction(interaction);
  } catch (error) {
    console.error('Failed to handle interaction:', error);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: 'Không thể xử lý yêu cầu lúc này. Vui lòng thử lại sau.',
          flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined,
        })
        .catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await dailyReport.handleMessage(message);
  } catch (error) {
    console.error('Failed to handle message:', error);

    if (!message.author.bot && message.inGuild()) {
      await message.reply('Không thể xử lý yêu cầu lúc này. Vui lòng thử lại sau.').catch(() => {});
    }
  }
});

client.login(config.token);
