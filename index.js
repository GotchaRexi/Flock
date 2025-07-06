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

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  console.log(`Received: ${message.content}`); // Debug logging

  const isCommander = message.member.roles.cache.some(role => role.name === 'Quack Commander');
  const channelId = message.channel.id;

  // Start race
  if (isCommander && message.content.toLowerCase().startsWith('start race')) {
    const total = parseInt(message.content.split(' ')[2]);
    if (isNaN(total) || total <= 0) return message.reply('Invalid spot count.');

    const res = await db.query('SELECT COUNT(*) FROM races WHERE channel_id = $1 AND closed = false', [channelId]);
    if (parseInt(res.rows[0].count) > 0) return message.reply('A race is already running in this channel.');

    const { rows } = await db.query(
      'INSERT INTO races (channel_id, race_number, total_spots, remaining_spots) VALUES ($1, COALESCE((SELECT MAX(race_number)+1 FROM races WHERE channel_id = $1), 1), $2, $2) RETURNING race_number',
      [channelId, total]
    );
    return message.channel.send(`Race #${rows[0].race_number} started with ${total} spots! Type X<number> to claim spots.`);
  }

  // Cancel race
  if (isCommander && message.content.toLowerCase() === 'cancel race') {
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0 || rows[0].closed) {
      return message.reply('There is no active race to cancel in this channel.');
    }

    await db.query('UPDATE races SET closed = true WHERE id = $1', [rows[0].id]);
    await message.channel.send(`Race #${rows[0].race_number} has been cancelled.`);
    return;
  }

  // Reset race
  if (isCommander && message.content.toLowerCase() === '!reset') {
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return message.reply('There is no active race to reset.');

    await db.query('DELETE FROM entries WHERE race_id = $1', [rows[0].id]);
    await db.query('UPDATE races SET remaining_spots = total_spots WHERE id = $1', [rows[0].id]);
    await message.channel.send(`Race #${rows[0].race_number} has been reset. All entries cleared.`);
    return;
  }

  // List entries
  if (message.content.toLowerCase() === '!list') {
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return message.reply('There is no active race to list.');

    const race = rows[0];
    const { rows: entryRows } = await db.query('SELECT COUNT(*) FROM entries WHERE race_id = $1', [race.id]);
    return message.channel.send(`Current entries: ${entryRows[0].count}`);
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

    const insertText = 'INSERT INTO entries (race_id, user_id, username) VALUES ' +
      Array(claimCount).fill(`($1, $2, $3)`).join(', ');
    const insertParams = Array(claimCount).fill([race.id, message.author.id, message.author.username]).flat();
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
