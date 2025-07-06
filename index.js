// index.js
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from 'dotenv';
import pkg from 'pg';
import express from 'express';

config();

const { Client: PGClient } = pkg;
const db = new PGClient({ connectionString: process.env.DATABASE_URL });
await db.connect();

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

  const isCommander = message.member.roles.cache.some(role => role.name === 'Quack Commander');
  const channelId = message.channel.id;
  const content = message.content.trim();

  if (content === '!commands') {
    return message.channel.send(`**Duck Race Bot Commands:**
!start <name> <spots> — Start a new race (Quack Commanders only)
x<number> — Claim spots in the active race
sipped — Mark yourself as sipped once race is full
!list <name> — Show all individual entries in a race
!status <name> — Show current summary of the race
!cancel <name> — Cancel an active race (Quack Commanders only)
!reset <name> — Clear all entries from a race (Quack Commanders only)
!forceclose <name> — Force a race to close early (Quack Commanders only)
!wipe — Clears all race data (Quack Commanders only, requires confirmation)`);
  }

  // !start
  const startMatch = content.match(/^!start\s+(\w+)\s+(\d+)$/i);
  if (startMatch) {
    if (!isCommander) return message.reply('Only a Quack Commander can start the race.');
    const raceName = startMatch[1];
    const total = parseInt(startMatch[2]);
    if (!raceName || isNaN(total) || total <= 0) return message.reply('Usage: !start <name> <spots>');

    const res = await db.query('SELECT COUNT(*) FROM races WHERE channel_id = $1 AND name = $2 AND closed = false', [channelId, raceName]);
    if (parseInt(res.rows[0].count) > 0) return message.reply('A race with that name is already running in this channel.');

    const { rows } = await db.query(
      'INSERT INTO races (channel_id, name, race_number, total_spots, remaining_spots, closed) VALUES ($1, $2, COALESCE((SELECT MAX(race_number)+1 FROM races WHERE channel_id = $1), 1), $3, $3, false) RETURNING id, race_number',
      [channelId, raceName, total]
    );
    return message.channel.send(`Race "${raceName}" (#${rows[0].race_number}) started with ${total} spots! Type X<number> to claim spots.`);
  }

  // x<number>
  const match = content.match(/^x(\d+)$/i);
  if (match) {
    const claimCount = parseInt(match[1]);
    if (isNaN(claimCount) || claimCount <= 0) return;

    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return;
    const race = rows[0];

    if (claimCount > race.remaining_spots) return message.reply(`Only ${race.remaining_spots} spots left!`);

    let placeholders = [], values = [];
    for (let i = 0; i < claimCount; i++) {
      placeholders.push(`($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`);
      values.push(race.id, message.author.id, message.member.displayName);
    }
    await db.query(`INSERT INTO entries (race_id, user_id, username) VALUES ${placeholders.join(', ')}`, values);
    const newRemaining = race.remaining_spots - claimCount;
    await db.query('UPDATE races SET remaining_spots = $1 WHERE id = $2', [newRemaining, race.id]);

    await message.channel.send(`${message.member.displayName} claimed ${claimCount} spot(s). ${newRemaining} spot(s) remaining in race "${race.name}".`);

    if (newRemaining === 0) {
      await db.query('UPDATE races SET closed = true WHERE id = $1', [race.id]);
      const finalEntries = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
      await message.channel.send(`The race is now full! ${finalEntries.rows.map(r => `<@${r.user_id}>`).join(', ')} please sip when available.`);
    }
    return;
  }

  // sipped
  if (content.toLowerCase() === 'sipped') {
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND closed = true ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return;

    const race = rows[0];
    const existing = await db.query('SELECT * FROM sips WHERE race_id = $1 AND user_id = $2', [race.id, message.author.id]);
    if (existing.rows.length > 0) return message.reply('You already sipped this race.');

    await db.query('INSERT INTO sips (race_id, user_id) VALUES ($1, $2)', [race.id, message.author.id]);
    await message.reply('Sip recorded.');

    const entrants = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
    const sippers = await db.query('SELECT DISTINCT user_id FROM sips WHERE race_id = $1', [race.id]);

    const allSipped = entrants.rows.every(e => sippers.rows.some(s => s.user_id === e.user_id));
    if (allSipped) await message.channel.send(`@here The race is full, sipped, and ready to run!`);
    return;
  }

  // !list <name>
  if (content.toLowerCase().startsWith('!list ')) {
    const raceName = content.split(' ')[1];
    const raceRes = await db.query('SELECT * FROM races WHERE channel_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1', [channelId, raceName]);
    if (raceRes.rows.length === 0) return message.reply('Race not found.');

    const race = raceRes.rows[0];
    const entries = await db.query('SELECT username FROM entries WHERE race_id = $1', [race.id]);
    if (entries.rows.length === 0) return message.channel.send('No entries yet.');

    return message.channel.send(`Entries for "${race.name}":\n${entries.rows.map(r => r.username).join('\n')}`);
  }

  // !status <name>
  if (content.toLowerCase().startsWith('!status ')) {
    const raceName = content.split(' ')[1];
    const raceRes = await db.query('SELECT * FROM races WHERE channel_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1', [channelId, raceName]);
    if (raceRes.rows.length === 0) return message.reply('Race not found.');

    const race = raceRes.rows[0];
    const entries = await db.query('SELECT username, COUNT(*) AS count FROM entries WHERE race_id = $1 GROUP BY username ORDER BY count DESC', [race.id]);

    return message.channel.send(`Race "${race.name}" Status: ${race.remaining_spots}/${race.total_spots} spots remaining.\n` +
      (entries.rows.length > 0 ? entries.rows.map(r => `${r.username} - ${r.count}`).join('\n') : 'No entries yet.'));
  }

  // !cancel <name>
  if (content.startsWith('!cancel ')) {
    if (!isCommander) return;
    const name = content.split(' ')[1];
    await db.query('UPDATE races SET closed = true WHERE channel_id = $1 AND name = $2 AND closed = false', [channelId, name]);
    return message.channel.send(`Race "${name}" has been cancelled.`);
  }

  // !reset <name>
  if (content.startsWith('!reset ')) {
    if (!isCommander) return;
    const name = content.split(' ')[1];
    const res = await db.query('SELECT * FROM races WHERE channel_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1', [channelId, name]);
    if (res.rows.length === 0) return;
    const race = res.rows[0];
    await db.query('DELETE FROM entries WHERE race_id = $1', [race.id]);
    await db.query('UPDATE races SET remaining_spots = total_spots, closed = false WHERE id = $1', [race.id]);
    return message.channel.send(`Entries reset for race "${name}".`);
  }

  // !forceclose <name>
  if (content.startsWith('!forceclose ')) {
    if (!isCommander) return;
    const name = content.split(' ')[1];
    const res = await db.query('SELECT * FROM races WHERE channel_id = $1 AND name = $2 AND closed = false ORDER BY id DESC LIMIT 1', [channelId, name]);
    if (res.rows.length === 0) return;
    const race = res.rows[0];
    await db.query('UPDATE races SET closed = true, remaining_spots = 0 WHERE id = $1', [race.id]);
    return message.channel.send(`Race "${name}" was force closed.`);
  }

  // !wipe (2-part confirmation)
  if (content === '!wipe') {
    if (!isCommander) return;
    pendingWipes.set(channelId, message.author.id);
    return message.reply('Are you sure you want to wipe all race data? Type `confirm` to proceed.');
  }

  if (content === 'confirm' && pendingWipes.get(channelId) === message.author.id) {
    await db.query('DELETE FROM entries');
    await db.query('DELETE FROM races');
    await db.query('DELETE FROM sips');
    pendingWipes.delete(channelId);
    return message.channel.send('All race data has been wiped.');
  }
});

client.login(process.env.BOT_TOKEN);

// Optional: keep alive
const app = express();
app.get('/', (_, res) => res.send('Bot running'));
app.listen(process.env.PORT || 3000);
