require('dotenv').config();
const { Client, Intents, Partials, GatewayIntentBits } = require('discord.js');
const axios = require('axios');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!DISCORD_TOKEN || !AUTH_TOKEN) {
  console.error('Missing environment variables. Please set DISCORD_TOKEN and AUTH_TOKEN in .env file.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

const ADMIN_ROLE_ID = 'admin role id discord';

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  // Fetch the full reaction if it's partial
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Error fetching reaction:', error);
      return;
    }
  }

  // Check if the reaction is the correct emoji (✅)
  if (reaction.emoji.name !== '✅') return;

  const message = reaction.message;
  const guild = message.guild;

  // Ensure the user is an admin
  const member = await guild.members.fetch(user.id).catch(console.error);
  if (!member || !member.roles.cache.has(ADMIN_ROLE_ID)) return;

  const helper = message.author;  // This is the player who needs the recognition
  if (!helper) {
    console.error('Could not fetch message author.');
    return;
  }

  // Use the helper's ID or another identifier for sending the webhook
  const serviceId = helper.id;  // Send webhook to the helper's ID

  const webhookUrl = `webhook url`;
  const payload = {
    helper_id: helper.id,
    helper_username: helper.username,
    description: `Administrator ${user.username} recognized ${helper.username} for helping.`,
    timestamp: new Date().toISOString(),
  };

  console.log('Payload:', payload);

  try {
    await delay(1000);
    await axios.post(webhookUrl, payload, {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`Sent webhook for helper: ${payload.helper_id}`);
    message.channel.send(
      `${helper.username} has been recognized for helping! 🎉 😊`
    );
  } catch (error) {
    console.error('Failed to send webhook:', error.response?.data || error.message);
    message.channel.send(
      `Failed to send recognition for ${helper.username}. Please try again later. 😢`
    );
  }
});

client.login(DISCORD_TOKEN);
