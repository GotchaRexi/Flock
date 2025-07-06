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

  // Handle "sipped"
  if (message.content.toLowerCase().trim() === 'sipped') {
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND closed = true ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return;

    const race = rows[0];
    const alreadySipped = await db.query('SELECT * FROM sips WHERE race_id = $1 AND user_id = $2', [race.id, message.author.id]);
    if (alreadySipped.rows.length > 0) return message.reply('You already sipped this race.');

    await db.query('INSERT INTO sips (race_id, user_id) VALUES ($1, $2)', [race.id, message.author.id]);
    await message.reply('Sipped recorded. Thank you!');

    const entrants = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
    const allSipped = entrants.rows.every(e => alreadySipped.rows.some(s => s.user_id === e.user_id) || e.user_id === message.author.id);

    if (allSipped) {
      const starter = await db.query('SELECT username FROM entries WHERE race_id = $1 ORDER BY rowid ASC LIMIT 1', [race.id]);
      const mentions = entrants.rows.map(r => `<@${r.user_id}>`).join(', ');
      await message.channel.send(`${mentions} The race is full and sipped, ready to run!`);
    }
    return;
  }

  // Start race with name
  if (message.content.toLowerCase().startsWith('!start ')) {
    if (!isCommander) return message.reply('Only a Quack Commander can start the race.');

    const parts = message.content.trim().split(/\s+/);
    const raceName = parts[1];
    const total = parseInt(parts[2]);
    if (!raceName || isNaN(total) || total <= 0) return message.reply('Usage: !start <name> <spots>');

    const res = await db.query('SELECT COUNT(*) FROM races WHERE channel_id = $1 AND name = $2 AND closed = false', [channelId, raceName]);
    if (parseInt(res.rows[0].count) > 0) return message.reply('A race with that name is already running in this channel.');

    const { rows } = await db.query(
      'INSERT INTO races (channel_id, name, race_number, total_spots, remaining_spots, closed) VALUES ($1, $2, COALESCE((SELECT MAX(race_number)+1 FROM races WHERE channel_id = $1), 1), $3, $3, false) RETURNING race_number, id',
      [channelId, raceName, total]
    );
    return message.channel.send(`Race "${raceName}" (#${rows[0].race_number}) started with ${total} spots! Type X<number> to claim spots.`);
  }

  // Status command with summarized list
  if (message.content.toLowerCase().startsWith('!status ')) {
    const raceName = message.content.split(/\s+/)[1];
    if (!raceName) return message.reply('Usage: !status <raceName>');

    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1', [channelId, raceName]);
    if (rows.length === 0) return message.reply(`No race found with name "${raceName}" in this channel.`);

    const race = rows[0];
    const { rows: entryRows } = await db.query(
      'SELECT username, COUNT(*) as count FROM entries WHERE race_id = $1 GROUP BY username ORDER BY count DESC',
      [race.id]
    );

    const summaryList = entryRows.length > 0 ? entryRows.map(r => `${r.username} - ${r.count}`).join('\n') : 'No entries yet.';
    return message.channel.send(`Race "${race.name}" status: ${race.remaining_spots}/${race.total_spots} spots remaining${race.closed ? ' (closed)' : ''}.\nCurrent entries:\n${summaryList}`);
  }

  // List entries with full list per entry
  if (message.content.toLowerCase() === '!list') {
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return message.reply('There is no active race to list.');

    const race = rows[0];
    const { rows: entryRows } = await db.query(
      'SELECT username FROM entries WHERE race_id = $1',
      [race.id]
    );

    if (entryRows.length === 0) return message.channel.send('No entries yet.');

    const formattedList = entryRows.map(r => r.username).join('\n');
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
      insertParams.push(race.id, message.author.id, message.member.displayName);
    }
    const insertText = `INSERT INTO entries (race_id, user_id, username) VALUES ${placeholders.join(', ')}`;
    await db.query(insertText, insertParams);

    const newRemaining = race.remaining_spots - claimCount;
    await db.query('UPDATE races SET remaining_spots = $1 WHERE id = $2', [newRemaining, race.id]);

    await message.channel.send(`${message.member.displayName} claimed ${claimCount} spot(s). ${newRemaining} spot(s) remaining.`);

    if (newRemaining === 0) {
      await db.query('UPDATE races SET closed = true WHERE id = $1', [race.id]);
      const finalEntries = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
      const mentions = finalEntries.rows.map(r => `<@${r.user_id}>`).join(', ');
      await message.channel.send(`The race is now full! ${mentions} please sip when available.`);
    }
  }
});

client.login(process.env.BOT_TOKEN);

// Optional: keep alive
const app = express();
app.get('/', (_, res) => res.send('Bot running'));
app.listen(process.env.PORT || 3000);
