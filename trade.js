/**
 * Player Token Bot (balance + trade only)
 * ------------------------------------------------------
 * Public commands:
 *   /balance [user]     -> show token balance (defaults to caller)
 *   /trade user amount [reason]
 *                         -> transfer tokens P2P (checks sender balance, deducts then credits, rollback on failure)
 * Managers:
 *   /baldebug [user]    -> inspect which field holds the balance (public)
 *
 * Env (.env):
 *   DISCORD_TOKEN=...
 *   DISCORD_APP_ID=...
 *   GUILD_ID=...                 # required for instant guild registration
 *   GSA_API_URL=https://api.gameserverapp.com
 *   GSA_API_KEY=...              # System API bearer
 *   AUDIT_CHANNEL_ID=...         # optional, to announce trades in a log channel
 *   DRY_RUN=false                # true to simulate (no mutations)
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

// ---- ENV -------------------------------------------------------------------
const {
  DISCORD_TOKEN,
  DISCORD_APP_ID,
  GUILD_ID,
  GSA_API_URL = 'https://api.gameserverapp.com',
  GSA_API_KEY,
  AUDIT_CHANNEL_ID,
  DRY_RUN = 'false',
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_APP_ID || !GUILD_ID || !GSA_API_KEY) {
  console.error('[BOOT] Missing required env (DISCORD_TOKEN, DISCORD_APP_ID, GUILD_ID, GSA_API_KEY).');
  process.exit(1);
}
const isDryRun = /^(1|true|yes)$/i.test(DRY_RUN);

// ---- GSA client ------------------------------------------------------------
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
  const player = data?.data?.[0];
  return player || null; // expect { uuid, username, ... }
}

async function getPlayerDetails(playerUuid) {
  // Try canonical path
  try {
    const { data } = await gsa.get(`/system-api/v2/player/${playerUuid}`, {
      params: { include: 'stats' }
    });
    return data?.data || data || null;
  } catch (e1) {
    // Fallback: without include
    try {
      const { data } = await gsa.get(`/system-api/v2/player/${playerUuid}`);
      return data?.data || data || null;
    } catch (e2) {
      // Fallback: pluralized path seen in some setups
      try {
        const { data } = await gsa.get(`/system-api/v2/players/${playerUuid}`);
        return data?.data || data || null;
      } catch {
        return null;
      }
    }
  }
}

function findFirstNumericByKey(obj, keysRegex = /(token_?balance|tokens|balance|credits|points)/i) {
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === 'number' && keysRegex.test(k)) return { value: v, path: k };
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

async function getPlayerTokenBalance(playerUuid) {
  // 1) Details-based probes (common layouts)
  const details = await getPlayerDetails(playerUuid);
  if (details) {
    const candidates = [
      details?.stats?.token_balance,
      details?.stats?.tokens,
      details?.wallet?.tokens,
      details?.economy?.tokens,
      details?.token_balance,
      details?.tokens,
      details?.balance,
      details?.currency?.tokens,
    ];
    const picked = candidates.find(v => typeof v === 'number');
    if (typeof picked === 'number') return picked;

    // 2) Generic deep scan for a sensible numeric field name
    const found = findFirstNumericByKey(details);
    if (found && typeof found.value === 'number') return found.value;
  }

  // 3) Dedicated endpoints (if present in your deployment)
  try {
    const { data } = await gsa.get(`/system-api/v2/player/${playerUuid}/stats`);
    const v = data?.data?.token_balance ?? data?.data?.tokens ?? data?.token_balance ?? data?.tokens;
    if (typeof v === 'number') return v;
  } catch {}

  try {
    const { data } = await gsa.get(`/system-api/v2/player/${playerUuid}/token-balance`);
    const v = data?.data ?? data;
    if (typeof v === 'number') return v;
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

// ---- Per-player queue (respect GSA 5s cooldown per player) -----------------
const playerQueues = new Map(); // uuid -> promise chain
async function enqueueForPlayer(uuid, job) {
  const prev = playerQueues.get(uuid) || Promise.resolve();
  const next = prev.then(job).finally(() => {
    if (playerQueues.get(uuid) === next) playerQueues.delete(uuid);
  });
  playerQueues.set(uuid, next);
  return next;
}

// ---- Slash commands --------------------------------------------------------
const balanceCmd = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('Show token balance (public)')
  .addUserOption(o => o.setName('user').setDescription('Discord user (default: you)'));

const tradeCmd = new SlashCommandBuilder()
  .setName('trade')
  .setDescription('Send your own tokens to another player (public)')
  .addUserOption(o => o.setName('user').setDescription('Recipient (must be linked in GSA)').setRequired(true))
  .addIntegerOption(o => o.setName('amount').setDescription('Amount to send (minimum 1)').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Optional note (e.g., trade, gift)'))
  .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

// #3: Manager-only balance inspector
const balDebugCmd = new SlashCommandBuilder()
  .setName('baldebug')
  .setDescription('Managers: inspect balance fields for a user (public)')
  .addUserOption(o => o.setName('user').setDescription('Discord user (default: you)'));

const commandsJSON = [balanceCmd.toJSON(), tradeCmd.toJSON(), balDebugCmd.toJSON()];

// ---- Register (guild-only) -------------------------------------------------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, GUILD_ID), { body: commandsJSON });
  console.log('[Slash] Registered guild commands:', commandsJSON.map(c => c.name));
}

// ---- Discord client --------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', async () => {
  console.log(`[Ready] Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('[Slash] Failed to register', e?.response?.data || e);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply({ ephemeral: false }); // everything public

    const name = interaction.commandName;

    // ---------------------- /balance ----------------------
    if (name === 'balance') {
      const user = interaction.options.getUser('user') || interaction.user;
      const player = await findPlayerByServiceId(user.id);
      if (!player) {
        return interaction.editReply(`❌ No GSA player found for **${user.tag}**. Is Discord linked in GSA?`);
      }
      try {
        const bal = await getPlayerTokenBalance(player.uuid);
        return interaction.editReply(`💳 **${player.username}** has **${bal}** tokens.`);
      } catch {
        return interaction.editReply('❌ Could not fetch token balance.');
      }
    }

    // ---------------------- /trade ------------------------
    if (name === 'trade') {
      const recipientUser = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);
      const note = interaction.options.getString('reason') || `P2P transfer by ${interaction.user.tag}`;

      if (!Number.isInteger(amount) || amount <= 0) {
        return interaction.editReply('❌ Amount must be a positive whole number.');
      }
      if (recipientUser.id === interaction.user.id) {
        return interaction.editReply('❌ You cannot pay yourself.');
      }

      // Resolve sender & recipient
      const senderPlayer = await findPlayerByServiceId(interaction.user.id);
      if (!senderPlayer) return interaction.editReply('❌ Your Discord is not linked to a GSA player.');
      const recipientPlayer = await findPlayerByServiceId(recipientUser.id);
      if (!recipientPlayer) {
        return interaction.editReply(`❌ No GSA player found for **${recipientUser.tag}**. Is their Discord linked in GSA?`);
      }

      // Check sender balance
      let senderBalance;
      try {
        senderBalance = await getPlayerTokenBalance(senderPlayer.uuid);
      } catch {
        return interaction.editReply('❌ Could not check your token balance.');
      }
      if (senderBalance < amount) {
        return interaction.editReply(`❌ Not enough tokens. You have **${senderBalance}**, need **${amount}**.`);
      }

      // Perform transfer with per-player queues and rollback
      let deducted = false;
      try {
        // deduct from sender
        await enqueueForPlayer(senderPlayer.uuid, async () => {
          await mutatePlayerTokens(senderPlayer.uuid, -amount, `${note} → ${recipientPlayer.username}`);
        });
        deducted = true;

        // credit recipient
        await enqueueForPlayer(recipientPlayer.uuid, async () => {
          await mutatePlayerTokens(recipientPlayer.uuid, amount, `${note} ← ${senderPlayer.username}`);
        });
      } catch (e) {
        if (deducted) {
          try {
            await enqueueForPlayer(senderPlayer.uuid, async () => {
              await mutatePlayerTokens(senderPlayer.uuid, amount, `Rollback for failed transfer to ${recipientPlayer.username}`);
            });
          } catch {}
        }
        return interaction.editReply('❌ Transfer failed. No tokens should be lost.');
      }

      // Optional: show new sender balance
      let newBal = null;
      try { newBal = await getPlayerTokenBalance(senderPlayer.uuid); } catch {}

      await interaction.editReply(
        `✅ **${interaction.user.tag}** sent **${amount}** tokens to **${recipientPlayer.username}** (<@${recipientUser.id}>)` +
        (typeof newBal === 'number' ? `\n💳 Your new balance: **${newBal}**` : '')
      );

      // Optional audit embed
      if (AUDIT_CHANNEL_ID) {
        const ch = interaction.guild.channels.cache.get(AUDIT_CHANNEL_ID);
        if (ch && 'send' in ch) {
          const embed = new EmbedBuilder()
            .setTitle('🤝 Player Trade')
            .setDescription(`**${amount}** tokens`)
            .addFields(
              { name: 'From', value: `${senderPlayer.username} (<@${interaction.user.id}>)`, inline: true },
              { name: 'To', value: `${recipientPlayer.username} (<@${recipientUser.id}>)`, inline: true },
              { name: 'Note', value: note, inline: false },
            )
            .setTimestamp(new Date());
          ch.send({ embeds: [embed] }).catch(() => {});
        }
      }
      return;
    }

    // ---------------------- /baldebug (Managers only) -----------------------
    if (name === 'baldebug') {
      const MANAGER_ROLE_ID = '1244365695114809445';
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!member.roles.cache.has(MANAGER_ROLE_ID)) {
        return interaction.editReply('⛔ Managers only.');
      }

      const user = interaction.options.getUser('user') || interaction.user;
      const player = await findPlayerByServiceId(user.id);
      if (!player) return interaction.editReply(`❌ No GSA player found for **${user.tag}**.`);

      let details = null;
      try { details = await getPlayerDetails(player.uuid); } catch {}
      if (!details) return interaction.editReply('❌ Could not fetch player details.');

      const snapshot = {
        username: player.username,
        uuid: player.uuid,
        picks: {
          'stats.token_balance': details?.stats?.token_balance,
          'stats.tokens': details?.stats?.tokens,
          'wallet.tokens': details?.wallet?.tokens,
          'economy.tokens': details?.economy?.tokens,
          'token_balance': details?.token_balance,
          'tokens': details?.tokens,
          'balance': details?.balance,
          'currency.tokens': details?.currency?.tokens,
        }
      };

      await interaction.editReply('```json\n' + JSON.stringify(snapshot, null, 2) + '\n```');
      return;
    }

  } catch (err) {
    console.error('[Interaction error]', err?.response?.data || err);
    const apiMsg = err?.response?.data?.error || err?.response?.data?.message;
    const hint = apiMsg ? `\n🔎 API: ${apiMsg}` : '';
    if (err?.response?.status === 429) {
      return interaction.editReply(`⏳ Slow down! This player has a 5s cooldown.${hint}`);
    }
    return interaction.editReply(`❌ Something went wrong.${hint}`);
  }
});

client.login(DISCORD_TOKEN);
