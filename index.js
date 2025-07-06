// index.js
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from 'dotenv';
import pkg from 'pg';
import express from 'express';

config();

const { Client: PGClient } = pkg;
const db = new PGClient({ connectionString: process.env.DATABASE_URL });
await db.connect();

// Ensure sips table exists with composite key
await db.query(`
  CREATE TABLE IF NOT EXISTS sips (
    race_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (race_id, user_id)
  );
`);

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

  console.log(`Received: ${message.content}`);

  const isCommander = message.member.roles.cache.some(role => role.name === 'Quack Commander');
  const channelId = message.channel.id;

  // Handle !start <name> <spots>
  const startMatch = message.content.trim().match(/^!start\s+(\w+)\s+(\d+)$/i);
  if (startMatch) {
    if (!isCommander) return message.reply('Only a Quack Commander can start the race.');

    const raceName = startMatch[1];
    const total = parseInt(startMatch[2]);
    if (!raceName || isNaN(total) || total <= 0) return message.reply('Usage: !start <name> <spots>');

    const res = await db.query('SELECT COUNT(*) FROM races WHERE channel_id = $1 AND name = $2 AND closed = false', [channelId, raceName]);
    if (parseInt(res.rows[0].count) > 0) return message.reply('A race with that name is already running in this channel.');

    const { rows } = await db.query(
      'INSERT INTO races (channel_id, name, race_number, total_spots, remaining_spots, closed) VALUES ($1, $2, COALESCE((SELECT MAX(race_number)+1 FROM races WHERE channel_id = $1), 1), $3, $3, false) RETURNING race_number, id',
      [channelId, raceName, total]
    );
    return message.channel.send(`Race "${raceName}" (#${rows[0].race_number}) started with ${total} spots! Type X<number> to claim spots.`);
  }

  // Handle "sipped"
  if (message.content.toLowerCase().trim() === 'sipped') {
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND closed = true ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return;

    const race = rows[0];
    const alreadySipped = await db.query('SELECT * FROM sips WHERE race_id = $1 AND user_id = $2', [race.id, message.author.id]);
    if (alreadySipped.rows.length > 0) return message.reply('You already sipped this race.');

    await db.query('INSERT INTO sips (race_id, user_id) VALUES ($1, $2)', [race.id, message.author.id]);
    await message.reply('Sip recorded.');

    const entrants = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
    const allSips = await db.query('SELECT DISTINCT user_id FROM sips WHERE race_id = $1', [race.id]);
    const allSipped = entrants.rows.every(e => allSips.rows.some(s => s.user_id === e.user_id));

    if (allSipped) {
      const mentions = entrants.rows.map(r => `<@${r.user_id}>`).join(', ');
      await message.channel.send(`${mentions} The race is full, sipped, and ready to run!`);
    }
    return;
  }

  // Handle spot claims
  const match = message.content.trim().match(/^x(\d+)$/i);
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

    await message.channel.send(`${message.member.displayName} claimed ${claimCount} spot(s). ${newRemaining} spot(s) remaining in race "${race.name}".`);

    if (newRemaining === 0) {
      await db.query('UPDATE races SET closed = true WHERE id = $1', [race.id]);
      const finalEntries = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
      const mentions = finalEntries.rows.map(r => `<@${r.user_id}>`).join(', ');
      await message.channel.send(`The race is now full! ${mentions} please sip when available.`);
    }
    return;
  }

  // Handle !list <raceName> with full entry list
  const listMatch = message.content.trim().match(/^!list\s+(\w+)$/i);
  if (listMatch) {
    const raceName = listMatch[1];
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1', [channelId, raceName]);
    if (rows.length === 0) return message.reply(`No race named "${raceName}" found in this channel.`);
    const race = rows[0];

    const entries = await db.query('SELECT username FROM entries WHERE race_id = $1', [race.id]);
    if (entries.rows.length === 0) return message.reply('No one has entered this race yet.');

    const listText = entries.rows.map(e => e.username).join('\n');
    await message.channel.send(`Entries for race "${race.name}":\n${listText}`);
    return;
  }

  // Handle !status <raceName> with summary
  const statusMatch = message.content.trim().match(/^!status\s+(\w+)$/i);
  if (statusMatch) {
    const raceName = statusMatch[1];
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1', [channelId, raceName]);
    if (rows.length === 0) return message.reply(`No race named "${raceName}" found in this channel.`);
    const race = rows[0];

    const summary = await db.query('SELECT username, COUNT(*) as count FROM entries WHERE race_id = $1 GROUP BY username ORDER BY count DESC', [race.id]);
    const summaryText = summary.rows.map(r => `${r.username} - ${r.count}`).join('\n') || 'No entries yet.';

    await message.channel.send(`Race "${race.name}" status: ${race.remaining_spots}/${race.total_spots} spots remaining${race.closed ? ' (closed)' : ''}.\nCurrent entries:\n${summaryText}`);
    return;
  }

  // Add other command handling here
});

client.login(process.env.BOT_TOKEN);

// Optional: keep alive
const app = express();
app.get('/', (_, res) => res.send('Bot running'));
app.listen(process.env.PORT || 3000);
