// index.js
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from 'dotenv';
import pkg from 'pg';
import express from 'express';

config();

const { Client: PGClient } = pkg;
const db = new PGClient({ connectionString: process.env.DATABASE_URL });
await db.connect();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

const pendingWipes = new Map();

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  console.log(`Received: ${message.content}`); // Debug logging

  const isCommander = message.member.roles.cache.some(role => role.name === 'Quack Commander');
  const channelId = message.channel.id;

  // Start race with name
  if (isCommander && message.content.toLowerCase().startsWith('start race')) {
    const parts = message.content.trim().split(/\s+/);
    const raceName = parts[2];
    const total = parseInt(parts[3]);
    if (!raceName || isNaN(total) || total <= 0) return message.reply('Usage: start race <name> <spots>');

    const res = await db.query('SELECT COUNT(*) FROM races WHERE channel_id = $1 AND name = $2 AND closed = false', [channelId, raceName]);
    if (parseInt(res.rows[0].count) > 0) return message.reply('A race with that name is already running in this channel.');

    const { rows } = await db.query(
      'INSERT INTO races (channel_id, name, race_number, total_spots, remaining_spots, closed) VALUES ($1, $2, COALESCE((SELECT MAX(race_number)+1 FROM races WHERE channel_id = $1), 1), $3, $3, false) RETURNING race_number',
      [channelId, raceName, total]
    );
    return message.channel.send(`Race "${raceName}" (#${rows[0].race_number}) started with ${total} spots! Type X<number> to claim spots.`);
  }

  // Cancel race with name
  if (isCommander && message.content.toLowerCase().startsWith('cancel ')) {
    const raceName = message.content.split(/\s+/)[1];
    if (!raceName) return message.reply('Usage: cancel <raceName>');

    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND name = $2 AND closed = false ORDER BY id DESC LIMIT 1', [channelId, raceName]);
    if (rows.length === 0) return message.reply(`No active race named "${raceName}" to cancel.`);

    await db.query('UPDATE races SET closed = true WHERE id = $1', [rows[0].id]);
    return message.channel.send(`Race "${raceName}" has been cancelled.`);
  }

  // Force close race with name
  if (isCommander && message.content.toLowerCase().startsWith('!forceclose ')) {
    const raceName = message.content.split(/\s+/)[1];
    if (!raceName) return message.reply('Usage: !forceclose <raceName>');

    await db.query('UPDATE races SET closed = true WHERE channel_id = $1 AND name = $2 AND closed = false', [channelId, raceName]);
    return message.channel.send(`Force-closed any open races named "${raceName}" in this channel.`);
  }

  // Reset race with name
  if (isCommander && message.content.toLowerCase().startsWith('!reset ')) {
    const raceName = message.content.split(/\s+/)[1];
    if (!raceName) return message.reply('Usage: !reset <raceName>');

    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND name = $2 AND closed = false ORDER BY id DESC LIMIT 1', [channelId, raceName]);
    if (rows.length === 0) return message.reply(`No active race named "${raceName}" to reset.`);

    await db.query('DELETE FROM entries WHERE race_id = $1', [rows[0].id]);
    await db.query('UPDATE races SET remaining_spots = total_spots WHERE id = $1', [rows[0].id]);
    return message.channel.send(`Race "${raceName}" has been reset. All entries cleared.`);
  }

  // Wipe all races and entries with confirmation
  if (isCommander && message.content.toLowerCase() === '!wipe') {
    pendingWipes.set(message.author.id, true);
    return message.reply('⚠️ This will delete ALL races and entries. Type `!confirmwipe` to proceed.');
  }

  if (isCommander && message.content.toLowerCase() === '!confirmwipe') {
    if (!pendingWipes.get(message.author.id)) {
      return message.reply('No wipe action is pending. Run `!wipe` first.');
    }
    pendingWipes.delete(message.author.id);
    try {
      await db.query('DELETE FROM entries');
      await db.query('DELETE FROM races');
      return message.channel.send('✅ All race and entry data has been wiped from the database.');
    } catch (err) {
      console.error('Wipe error:', err);
      return message.reply('Failed to wipe data. Check logs.');
    }
  }

  // Race status
  if (message.content.toLowerCase().startsWith('!status ')) {
    const raceName = message.content.split(/\s+/)[1];
    if (!raceName) return message.reply('Usage: !status <raceName>');

    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1', [channelId, raceName]);
    if (rows.length === 0) return message.reply(`No race found with name "${raceName}" in this channel.`);

    const race = rows[0];
    return message.channel.send(`Race "${race.name}" status: ${race.remaining_spots}/${race.total_spots} spots remaining${race.closed ? ' (closed)' : ''}.`);
  }

  // List entries
  if (message.content.toLowerCase() === '!list') {
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return message.reply('There is no active race to list.');

    const race = rows[0];
    const { rows: entryRows } = await db.query(
      'SELECT username, COUNT(*) as count FROM entries WHERE race_id = $1 GROUP BY username ORDER BY count DESC',
      [race.id]
    );

    if (entryRows.length === 0) return message.channel.send('No entries yet.');

    const formattedList = entryRows.map(r => `${r.username} - ${r.count}`).join('\n');
    return message.channel.send(`Current entries:\n${formattedList}`);
  }

  // Claim spots
  const match = message.content.trim().match(/^x(\d+)$/i);
  console.log(`Regex match result:`, match); // Debug logging

  if (match) {
    const claimCount = parseInt(match[1]);
    if (isNaN(claimCount) || claimCount <= 0) return;

    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return;
    const race = rows[0];

    if (claimCount > race.remaining_spots) return message.reply(`Only ${race.remaining_spots} spots left!`);

    let placeholders = [];
    let insertParams = [];
    for (let i = 0; i < claimCount; i++) {
      const baseIndex = i * 3;
      placeholders.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3})`);
      insertParams.push(race.id, message.author.id, message.author.username);
    }
    const insertText = `INSERT INTO entries (race_id, user_id, username) VALUES ${placeholders.join(', ')}`;
    await db.query(insertText, insertParams);

    const newRemaining = race.remaining_spots - claimCount;
    await db.query('UPDATE races SET remaining_spots = $1 WHERE id = $2', [newRemaining, race.id]);

    await message.channel.send(`${message.author.username} claimed ${claimCount} spot(s). ${newRemaining} spot(s) remaining.`);

    if (newRemaining === 0) {
      await db.query('UPDATE races SET closed = true WHERE id = $1', [race.id]);
      const finalEntries = await db.query('SELECT username FROM entries WHERE race_id = $1', [race.id]);
      const list = finalEntries.rows.map(r => r.username).join('\n');
      await message.channel.send(`Race is full! Final list:\n${list}`);
    }
  }
});

client.login(process.env.BOT_TOKEN);

// Optional: keep alive
const app = express();
app.get('/', (_, res) => res.send('Bot running'));
app.listen(process.env.PORT || 3000);
