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

const RACE_THRESHOLDS = [75, 50, 25, 10];

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

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

  // Claim spots
  if (/^x\d+$/i.test(message.content.trim())) {
    const claimCount = parseInt(message.content.slice(1));
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

    const announced = await db.query('SELECT threshold FROM race_thresholds WHERE race_id = $1', [race.id]);
    const alreadyAnnounced = announced.rows.map(r => r.threshold);

    for (const t of RACE_THRESHOLDS) {
      if (newRemaining === t && !alreadyAnnounced.includes(t)) {
        await db.query('INSERT INTO race_thresholds (race_id, threshold) VALUES ($1, $2)', [race.id, t]);
        await message.channel.send(`${t} spots remaining!`);
      }
    }

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