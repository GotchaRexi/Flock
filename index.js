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
!forceclose <name> — Force a race to close early (Quack Commanders only)`);
  }

  // !start
  const startMatch = content.match(/^!start\s+(\w+)\s+(\d+)$/i);
  if (startMatch) {
    if (!isCommander) return message.reply('Only a Quack Commander can start the race.');
    const raceName = startMatch[1].toLocaleLowerCase();
    const total = parseInt(startMatch[2]);
    if (!raceName || isNaN(total) || total <= 0) return message.reply('Usage: !start <name> <spots>');

    const res = await db.query('SELECT COUNT(*) FROM races WHERE channel_id = $1 AND LOWER(name) = $2 AND closed = false', [channelId, raceName]);
    if (parseInt(res.rows[0].count) > 0) return message.reply('A race with that name is already running in this channel.');

    const { rows } = await db.query(
      'INSERT INTO races (channel_id, name, race_number, total_spots, remaining_spots, closed) VALUES ($1, $2, COALESCE((SELECT MAX(race_number)+1 FROM races WHERE channel_id = $1), 1), $3, $3, false) RETURNING id, race_number',
      [channelId, raceName, total]
    );
    return message.channel.send(`Race "${raceName}" (#${rows[0].race_number}) started with ${total} spots! Type X<number> to claim spots.`);
  }


    // Handle x<number> or x<number> for @user or x close
  const xCloseMatch = content.match(/^x\s*close$/i);
  if (xCloseMatch) {
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return;
    const race = rows[0];
    const targetId = message.author.id;
    const targetName = message.member.displayName;
    const claimCount = race.remaining_spots;

    if (claimCount <= 0) return message.reply('There are no remaining spots to claim.');

    const entries = [];
    for (let i = 0; i < claimCount; i++) {
      entries.push(`(${race.id}, '${targetId}', '${targetName.replace(/'/g, "''")}')`);
    }
    await db.query(`INSERT INTO entries (race_id, user_id, username) VALUES ${entries.join(', ')}`);
    await db.query('UPDATE races SET remaining_spots = 0, closed = true WHERE id = $1', [race.id]);


    const finalEntries = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
    const alreadySipped = await db.query('SELECT user_id FROM sips WHERE race_id = $1', [race.id]);
    const alreadySippedIds = new Set(alreadySipped.rows.map(r => r.user_id));

    const unsippedMentions = finalEntries.rows
    .filter(r => !alreadySippedIds.has(r.user_id))
    .map(r => `<@${r.user_id}>`)
    .join(', ');

    await message.channel.send(`The race is now full! ${unsippedMentions} please sip when available.`);

    return;
  }

  const claimMatch = content.match(/^x(\d+)(?:\s+for\s+<@!?(\d+)>)*$/i);
  if (claimMatch) {
    const claimCount = parseInt(claimMatch[1]);
    const targetId = claimMatch[2] || message.author.id;
    const targetName = claimMatch[2] ? (message.mentions.members.first()?.displayName || 'Unknown') : message.member.displayName;

    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return;

    const race = rows[0];
    if (claimCount > race.remaining_spots) return message.reply(`Only ${race.remaining_spots} spots left!`);

    const entries = [];
    for (let i = 0; i < claimCount; i++) {
      entries.push(`(${race.id}, '${targetId}', '${targetName.replace(/'/g, "''")}')`);
    }
    await db.query(`INSERT INTO entries (race_id, user_id, username) VALUES ${entries.join(', ')}`);
    const newRemaining = race.remaining_spots - claimCount;
    await db.query('UPDATE races SET remaining_spots = $1 WHERE id = $2', [newRemaining, race.id]);

    await message.channel.send(`${targetName} claimed ${claimCount} spot(s). ${newRemaining} spot(s) remaining in race "${race.name}".`);

    if (newRemaining === 0) {
      await db.query('UPDATE races SET closed = true WHERE id = $1', [race.id]);
      const finalEntries = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
      const mentions = finalEntries.rows.map(r => `<@${r.user_id}>`).join(', ');
      await message.channel.send(`The race is now full! ${mentions} please sip when available.`);
    }
    return;
  }

      // Handle "sipped" (now allowed even if race isn't full yet)
    /*if (['sipped', 'sip'].includes(content.toLowerCase())) {
    const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 ORDER BY id DESC LIMIT 1', [channelId]);
    if (rows.length === 0) return;

    const race = rows[0];
    const alreadySipped = await db.query('SELECT * FROM sips WHERE race_id = $1 AND user_id = $2', [race.id, message.author.id]);
    if (alreadySipped.rows.length > 0) return message.reply('You already sipped this race.');

    await db.query('INSERT INTO sips (race_id, user_id) VALUES ($1, $2)', [race.id, message.author.id]);
    await message.reply('Sip recorded.');

    if (race.closed) {
      const entrants = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
      const allSips = await db.query('SELECT DISTINCT user_id FROM sips WHERE race_id = $1', [race.id]);
      const allSipped = entrants.rows.every(e => allSips.rows.some(s => s.user_id === e.user_id));

      if (allSipped) {
        await message.channel.send(`@here The race is full, sipped, and ready to run!`);
      }
    }
    return;
  }*/

      // Handle "sipped" (now allowed even if race isn't full yet)
    if (['sipped', 'sip'].includes(content.toLowerCase())) {
  const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 ORDER BY id DESC LIMIT 1', [channelId]);
  if (rows.length === 0) return;

  const race = rows[0];

  // Ensure user has entries in this race
  const entryCheck = await db.query('SELECT COUNT(*) FROM entries WHERE race_id = $1 AND user_id = $2', [race.id, message.author.id]);
  if (parseInt(entryCheck.rows[0].count) === 0) {
    return message.reply('You cannot sip because you have not claimed any spots in this race.');
  }

  const alreadySipped = await db.query('SELECT * FROM sips WHERE race_id = $1 AND user_id = $2', [race.id, message.author.id]);
  if (alreadySipped.rows.length > 0) return message.reply('You already sipped this race.');

  await db.query('INSERT INTO sips (race_id, user_id) VALUES ($1, $2)', [race.id, message.author.id]);
  await message.reply('Sip recorded.');

  if (race.closed) {
    const entrants = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
    const allSips = await db.query('SELECT DISTINCT user_id FROM sips WHERE race_id = $1', [race.id]);
    const allSipped = entrants.rows.every(e => allSips.rows.some(s => s.user_id === e.user_id));

    if (allSipped) {
      await message.channel.send(`@here The race is full, sipped, and ready to run!`);
    }
  }
  return;
}


  // !list <name>
  if (content.toLowerCase().startsWith('!list ')) {
    const raceName = content.split(' ')[1].toLowerCase();
    const raceRes = await db.query('SELECT * FROM races WHERE channel_id = $1 AND LOWER(name) = $2 ORDER BY id DESC LIMIT 1', [channelId, raceName]);
    if (raceRes.rows.length === 0) return message.reply('Race not found.');

    const race = raceRes.rows[0];
    const entries = await db.query('SELECT username FROM entries WHERE race_id = $1', [race.id]);
    if (entries.rows.length === 0) return message.channel.send('No entries yet.');

    return message.channel.send(`Entries for "${race.name}":\n${entries.rows.map(r => r.username).join('\n')}`);
  }

    // Handle !status <name>
    if (content.toLowerCase().startsWith('!status ')) {
        const raceName = content.split(' ')[1].toLowerCase();
        const raceRes = await db.query('SELECT * FROM races WHERE channel_id = $1 AND LOWER(name) = $2 ORDER BY id DESC LIMIT 1', [channelId, raceName]);
        if (raceRes.rows.length === 0) return message.reply('Race not found.');
    
        const race = raceRes.rows[0];
        const entries = await db.query('SELECT user_id, username, COUNT(*) AS count FROM entries WHERE race_id = $1 GROUP BY user_id, username ORDER BY count DESC', [race.id]);
    
        const sipped = await db.query('SELECT user_id FROM sips WHERE race_id = $1', [race.id]);
        const sipStatus = sipped.rows.map(row => row.user_id);
    
        const statusList = entries.rows.map(entry => {
          const sipped = sipStatus.includes(entry.user_id);
          return `${entry.username} - ${entry.count}${sipped ? ' - Sipped' : ''}`;
        }).join('\n');
    
        return message.channel.send(`Race "${race.name}" Status: ${race.remaining_spots}/${race.total_spots} spots remaining.\n${statusList}`);
      }

  // !cancel <name>
  if (content.toLowerCase().startsWith('!cancel ')) {
    if (!isCommander) return message.reply('Only a Quack Commander can cancel the race.');
    const name = content.split(' ')[1].toLowerCase();
    const { rowCount } = await db.query('UPDATE races SET closed = true WHERE channel_id = $1 AND LOWER(name) = $2 AND closed = false', [channelId, name]);
    if (rowCount === 0) return message.reply(`Could not find an active race named "${name}" in this channel.`);
    return message.channel.send(`Race "${name}" has been cancelled.`);
  }

  // !reset <name>
  if (content.startsWith('!reset ')) {
    if (!isCommander) return message.reply('Only a Quack Commander can reset the race.');
    const name = content.split(' ')[1].toLowerCase();
    const res = await db.query('SELECT * FROM races WHERE channel_id = $1 AND LOWER(name) = $2 ORDER BY id DESC LIMIT 1', [channelId, name]);
    if (res.rows.length === 0) return;
    const race = res.rows[0];
    await db.query('DELETE FROM entries WHERE race_id = $1', [race.id]);
    await db.query('UPDATE races SET remaining_spots = total_spots, closed = false WHERE id = $1', [race.id]);
    return message.channel.send(`Entries reset for race "${name}".`);
  }

  // !forceclose <name>
  if (content.startsWith('!forceclose ')) {
    if (!isCommander) return message.reply('Only a Quack Commander can force close the race.');
    const name = content.split(' ')[1].toLowerCase();
    const res = await db.query('SELECT * FROM races WHERE channel_id = $1 AND LOWER(name) = $2 AND closed = false ORDER BY id DESC LIMIT 1', [channelId, name]);
    if (res.rows.length === 0) return;
    const race = res.rows[0];
    await db.query('UPDATE races SET closed = true, remaining_spots = 0 WHERE id = $1', [race.id]);
    return message.channel.send(`Race "${name}" was force closed.`);
  }

  // !wipe (2-part confirmation)
  if (content === '!wipe') {
    if (!isCommander) return;
    pendingWipes.set(channelId, message.author.id);
    return message.reply('Are you sure you want to delete all bot data? You should only do this if there is a fatal data error. Type `confirm` to proceed.');
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
