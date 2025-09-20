/**
 * 🌴 DinoParadise – GSA Token Dispatcher Bot (single-file)
 * ---------------------------------------------------------
 * ✨ What this bot does:
 *   - /tokens balance   → players can view their balance (public)
 *   - /tokens send      → managers can grant/remove custom amounts
 *   - /tokens preset    → managers can grant preset amounts
 *   - /tokens history   → managers can view recent transactions
 *
 * 🔒 Permissions:
 *   - Only members with MANAGER_ROLE_ID can use send/preset/history
 *   - Everyone can use /tokens balance
 *
 * ⚙️ Setup:
 *   1. Copy .env.example → .env and fill in the values below
 *   2. Replace MANAGER_ROLE_ID with your server’s manager role
 *   3. (Optional) Set AUDIT_CHANNEL_ID to log grants/removals
 *   4. Run:  node index.js
 */

const axios = require('axios');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');
require('dotenv').config();

// ---- ENVIRONMENT VARIABLES -------------------------------------------------
// 💡 CHANGE ME in your .env file
const {
  MANAGER_ROLE_ID     // youre discord admin id
  DISCORD_TOKEN,      // Your bot token
  DISCORD_APP_ID,     // Bot application ID
  GUILD_ID,           // Your Discord server ID (for instant registration)
  GSA_API_URL = 'https://api.gameserverapp.com',
  GSA_API_KEY,        // GSA System API key
  AUDIT_CHANNEL_ID,   // (Optional) Channel ID for logging grants/removals
  DRY_RUN = 'false',  // "true" → simulate without touching GSA
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_APP_ID || !GSA_API_KEY) {
  console.error('[BOOT] Missing required env (DISCORD_TOKEN, DISCORD_APP_ID, GSA_API_KEY).');
  process.exit(1);
}

// 💡 CHANGE ME → Set your manager role ID here
const MANAGER_ROLE_ID = 'youre admin id';

const isDryRun = /^(1|true|yes)$/i.test(DRY_RUN);

// Presets for quick grants
const TOKEN_PRESETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

// ---- QUEUE (respect 5s cooldown per player) --------------------------------
const playerQueues = new Map();
async function enqueueForPlayer(uuid, job) {
  const prev = playerQueues.get(uuid) || Promise.resolve();
  const next = prev.then(job).finally(() => {
    if (playerQueues.get(uuid) === next) playerQueues.delete(uuid);
  });
  playerQueues.set(uuid, next);
  return next;
}

// ---- GSA CLIENT ------------------------------------------------------------
const gsa = axios.create({
  baseURL: GSA_API_URL,
  headers: {
    Authorization: `Bearer ${GSA_API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 15_000,
});

async function findPlayerByServiceId(serviceId) {
  const { data } = await gsa.post('/system-api/v2/players/find', { service_id: String(serviceId) });
  return data?.data?.[0] || null;
}

async function getPlayerDetails(playerUuid) {
  const { data } = await gsa.get(`/system-api/v2/player/${playerUuid}`);
  return data?.data || null;
}

async function getPlayerTokenBalance(playerUuid) {
  const details = await getPlayerDetails(playerUuid).catch(() => null);
  if (details) {
    const possible = [
      details.token_balance,
      details.tokens,
      details.balance,
      details?.currency?.tokens,
    ].find(v => typeof v === 'number');
    if (typeof possible === 'number') return possible;
  }
  try {
    const { data } = await gsa.get(`/system-api/v2/player/${playerUuid}/token-balance`);
    if (typeof data?.data === 'number') return data.data;
  } catch {}
  throw new Error('Unable to fetch token balance');
}

async function mutatePlayerTokens(playerUuid, amount, description) {
  if (isDryRun) return { data: { data: 'DRY_RUN: Tokens would be mutated.' } };
  return gsa.post(`/system-api/v2/player/${playerUuid}/mutate-tokens`, {
    amount: Number(amount),
    description: description || undefined,
  });
}

async function getPlayerTokenHistory(playerUuid, limit = 10, page = 1) {
  const { data } = await gsa.get(`/system-api/v2/player/${playerUuid}/token-transactions`, {
    params: { per_page: Math.max(1, Math.min(100, limit)), page },
  });
  return data;
}

// ---- PERMISSION CHECK ------------------------------------------------------
function isManager(member) {
  return member.roles.cache.has(MANAGER_ROLE_ID);
}

// ---- SLASH COMMANDS --------------------------------------------------------
const tokensCmd = new SlashCommandBuilder()
  .setName('tokens')
  .setDescription('Manage and view GSA tokens for linked players')
  .addSubcommand(sc => sc
    .setName('send')
    .setDescription('Managers: grant/remove custom amount')
    .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount (+/-)').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Optional reason'))
  )
  .addSubcommand(sc => sc
    .setName('preset')
    .setDescription('Managers: grant a preset amount')
    .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
    .addIntegerOption(o => {
      const opt = o.setName('amount').setDescription('Choose preset').setRequired(true);
      TOKEN_PRESETS.forEach(v => opt.addChoices({ name: `${v}`, value: v }));
      return opt;
    })
    .addStringOption(o => o.setName('reason').setDescription('Optional reason'))
  )
  .addSubcommand(sc => sc
    .setName('history')
    .setDescription('Managers: show recent token transactions')
    .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
    .addIntegerOption(o => o.setName('limit').setDescription('How many (1-50)').setMinValue(1).setMaxValue(50))
  )
  .addSubcommand(sc => sc
    .setName('balance')
    .setDescription('Show token balance (public)')
    .addUserOption(o => o.setName('user').setDescription('Discord user (default: you)'))
  );

const commandsJSON = [tokensCmd.toJSON()];

// ---- REGISTER COMMANDS -----------------------------------------------------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, GUILD_ID), { body: commandsJSON });
  console.log('[Slash] Registered guild commands:', commandsJSON.map(c => c.name));
}

// ---- DISCORD CLIENT --------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', async () => {
  console.log(`[Ready] Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.error('[Slash] Failed to register', e); }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'tokens') return;

    const sub = interaction.options.getSubcommand();
    const isPublic = sub === 'balance';
    await interaction.deferReply({ ephemeral: !isPublic });

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const targetUser = interaction.options.getUser('user') || interaction.user;

    const player = await findPlayerByServiceId(targetUser.id);
    if (!player) {
      return interaction.editReply(`❌ No GSA player found for **${targetUser.tag}**. Is Discord linked in GSA?`);
    }

    // --- send/preset ---
    if (sub === 'send' || sub === 'preset') {
      if (!isManager(member)) return interaction.editReply('⛔ You do not have permission.');
      const amount = interaction.options.getInteger('amount', true);
      const reason = interaction.options.getString('reason') || `By ${interaction.user.tag}`;

      const result = await enqueueForPlayer(player.uuid, async () => {
        const res = await mutatePlayerTokens(player.uuid, amount, reason);
        return res?.data?.data || 'Tokens were mutated.';
      });

      await interaction.editReply(
        `✅ ${amount >= 0 ? 'Granted' : 'Removed'} **${Math.abs(amount)}** tokens for **${player.username}**\n${isDryRun ? '⚠️ DRY-RUN' : '🟢 ' + result}`
      );
      return;
    }

    // --- history ---
    if (sub === 'history') {
      if (!isManager(member)) return interaction.editReply('⛔ You do not have permission.');
      const limit = interaction.options.getInteger('limit') ?? 10;
      const data = await getPlayerTokenHistory(player.uuid, Math.min(50, Math.max(1, limit)));
      const list = (data?.data || []).map(tx => {
        const val = tx.transaction_value;
        const date = new Date(tx.date).toLocaleString();
        const who = tx.sender?.username || 'system';
        const desc = tx.description || '-';
        return `${date} • ${val >= 0 ? '➕' : '➖'}${Math.abs(val)} • by ${who} • ${desc}`;
      });
      if (!list.length) return interaction.editReply(`ℹ️ No transactions found for **${player.username}**.`);
      return interaction.editReply(`📜 Recent transactions:\n\n${list.join('\n')}`);
    }

    // --- balance ---
    if (sub === 'balance') {
      try {
        const bal = await getPlayerTokenBalance(player.uuid);
        return interaction.editReply(`💳 **${player.username}** has **${bal}** tokens.`);
      } catch {
        return interaction.editReply('❌ Could not fetch token balance.');
      }
    }

  } catch (err) {
    console.error('[Interaction error]', err?.response?.data || err);
    return interaction.editReply('❌ Something went wrong.');
  }
});

client.login(DISCORD_TOKEN);
