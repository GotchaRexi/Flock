// index.js
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from 'dotenv';
import pkg from 'pg';
import express from 'express';

config();

const { Client: PGClient } = pkg;
const pendingClaims = new Set();
const pendingWipes = new Map();

// Global variables
let db;
let client;
let server;

// Graceful shutdown handler
function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Starting graceful shutdown...`);
  
  if (client) {
    client.destroy();
    console.log('Discord client destroyed');
  }
  
  if (db) {
    db.end();
    console.log('Database connection closed');
  }
  
  if (server) {
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function initializeDatabase() {
  try {
    db = new PGClient({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    console.log('Database connected successfully');

    // Create tables
    await db.query(`
      CREATE TABLE IF NOT EXISTS sips (
        race_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (race_id, user_id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS vouches (
        race_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (race_id, user_id)
      );
    `);

    // Add vouched_by column if it doesn't exist
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='vouches' AND column_name='vouched_by'
        ) THEN
          ALTER TABLE vouches ADD COLUMN vouched_by TEXT;
        END IF;
      END
      $$;
    `);

    // Add ready_message_sent column to races table if it doesn't exist
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='races' AND column_name='ready_message_sent'
        ) THEN
          ALTER TABLE races ADD COLUMN ready_message_sent BOOLEAN DEFAULT FALSE;
        END IF;
      END
      $$;
    `);

    // Create bourbon values table
    await db.query(`
      CREATE TABLE IF NOT EXISTS bourbon_values (
        bottle_name TEXT PRIMARY KEY,
        value DECIMAL(10,2) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create retired users table
    await db.query(`
      CREATE TABLE IF NOT EXISTS retired_users (
        user_id TEXT PRIMARY KEY,
        retired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('Database tables initialized');
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exit(1);
  }
}

async function initializeDiscordBot() {
  try {
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction]
    });

    client.once('ready', () => {
      console.log(`Logged in as ${client.user.tag}`);
    });

    client.on('messageCreate', async (message) => {
      if (message.author.bot) return;

      const isCommander = message.member.roles.cache.some(role => role.name === 'Quack Commander');
      const channelId = message.channel.id;
      const content = message.content.trim();

      if (content === '!commands') {
        return message.channel.send(`**Duck Race Bot Commands:**
!start <name> <spots> — Start a new race (Quack Commanders only)
x<number> — Claim spots in the active race
x<number> for @user — Claim spots for someone else
sipped — Mark yourself as sipped once race is full
vouch for @user — Mark someone else as vouched
!list <name> — Show all individual entries in a race
!status <name> — Show current summary of the race
!remaining <name> — List users who haven't sipped or vouched
!remove <@user> - Remove a user from the race and reopen the race if it was closed
!cancel <name> — Cancel an active race (Quack Commanders only)
!reset <name> — Clear all entries from a race (Quack Commanders only)
!forceclose <name> — Force a race to close early (Quack Commanders only)
!value <bottlename> [bottlename2] ... — List values for specified bourbons
!updatevalue <bottlename> <value> — Update or add a bourbon value (Quack Commanders only)
!retire — Retire from racing (no more entries allowed)
!unretire — Unretire and return to racing`);
      }

      // !retire
      if (content === '!retire') {
        const retiredCheck = await db.query('SELECT * FROM retired_users WHERE user_id = $1', [message.author.id]);
        if (retiredCheck.rows.length > 0) {
          return message.reply('You are already retired from races.');
        }
        
        await db.query('INSERT INTO retired_users (user_id) VALUES ($1)', [message.author.id]);
        return message.reply('You have been retired from races. You can no longer enter any races.');
      }

      // !unretire
      if (content === '!unretire') {
        const retiredCheck = await db.query('SELECT * FROM retired_users WHERE user_id = $1', [message.author.id]);
        if (retiredCheck.rows.length === 0) {
          return message.reply('You are not currently retired from races.');
        }
        
        return message.reply('Do you want to spend your rent money on bourbon? Type Yes for degenerate and No for smart decision');
      }

      // Handle unretire confirmation
      if (content.toLowerCase() === 'yes' || content.toLowerCase() === 'no') {
        const retiredCheck = await db.query('SELECT * FROM retired_users WHERE user_id = $1', [message.author.id]);
        if (retiredCheck.rows.length === 0) {
          return; // Not in unretire flow
        }
        
        if (content.toLowerCase() === 'yes') {
          await db.query('DELETE FROM retired_users WHERE user_id = $1', [message.author.id]);
          return message.reply('Welcome back, degenerate! You can now enter races again.');
        } else {
          return message.reply('Smart choice. You remain retired from races.');
        }
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
          'INSERT INTO races (channel_id, name, race_number, total_spots, remaining_spots, closed, ready_message_sent) VALUES ($1, $2, COALESCE((SELECT MAX(race_number)+1 FROM races WHERE channel_id = $1), 1), $3, $3, false, false) RETURNING id, race_number',
          [channelId, raceName, total]
        );
        return message.channel.send(`Race "${raceName}" (#${rows[0].race_number}) started with ${total} spots! Type X<number> to claim spots.`);
      }

      // --------------------
      // Simple in-memory lock wrapper
      // --------------------
      async function runExclusive(channelId, message, fn) {
        if (pendingClaims.has(channelId)) {
          return message.reply(
            'Another claim is being processed—please wait a moment and try again.'
          );
        }
        pendingClaims.add(channelId);
        try {
          await fn();
        } finally {
          pendingClaims.delete(channelId);
        }
      }

      // --------------------
      // Handle "x close"
      // --------------------
      const xCloseMatch = content.match(/^x\s*close$/i);
      if (xCloseMatch) {
        return runExclusive(channelId, message, async () => {
          // Check if user is retired
          const retiredCheck = await db.query('SELECT * FROM retired_users WHERE user_id = $1', [message.author.id]);
          if (retiredCheck.rows.length > 0) {
            return message.reply('You are retired from races. Please take a moment to evaluate your choices');
          }

          // 1) fetch latest open race
          const { rows } = await db.query(
            'SELECT id, remaining_spots FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1',
            [channelId]
          );
          if (!rows.length) return;

          const { id: raceId, remaining_spots: count } = rows[0];
          if (count <= 0) {
            return message.reply('There are no remaining spots to claim.');
          }

          // 2) delete any existing sips
          await db.query(
            'DELETE FROM sips WHERE race_id = $1 AND user_id = $2',
            [raceId, message.author.id]
          );

          // 3) insert entries for all remaining spots
          const entriesSql = Array.from({ length: count }, () =>
            `(${raceId}, '${message.author.id}', '${message.member.displayName.replace(/'/g, "''")}')`
          ).join(', ');
          await db.query(
            `INSERT INTO entries (race_id, user_id, username) VALUES ${entriesSql}`
          );

          // 4) mark race closed
          await db.query(
            'UPDATE races SET remaining_spots = 0, closed = true WHERE id = $1',
            [raceId]
          );

          // 5) notify channel
          await message.channel.send('@here The race is now full! Please sip when available.');
        });
      }

      // --------------------
      // Handle "x<number>" and "x<number> for @user"
      // --------------------
      const claimMatch = content.match(/^x(\d+)(?:\s+for\s+<@!?(\d+)>)?/i);
      if (claimMatch) {
        return runExclusive(channelId, message, async () => {
          const want = parseInt(claimMatch[1], 10);
          const targetId = claimMatch[2] || message.author.id;
          const targetName = claimMatch[2]
            ? (message.mentions.members.first()?.displayName || 'Unknown')
            : message.member.displayName;

          // Check if target user is retired
          const retiredCheck = await db.query('SELECT * FROM retired_users WHERE user_id = $1', [targetId]);
          if (retiredCheck.rows.length > 0) {
            return message.reply('You are retired from races. Please take a moment to evaluate your choices');
          }

          // fetch the open race
          const { rows } = await db.query(
            'SELECT * FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1',
            [channelId]
          );
          if (!rows.length) return;

          const race = rows[0];
          
          // If they want more spots than available, give them all remaining spots
          const actualClaimed = Math.min(want, race.remaining_spots);
          const wasLimited = want > race.remaining_spots;

          // remove any old sip
          await db.query(
            'DELETE FROM sips WHERE race_id = $1 AND user_id = $2',
            [race.id, targetId]
          );

          // insert the new entries
          const entriesSql = Array.from({ length: actualClaimed }, () =>
            `(${race.id}, '${targetId}', '${targetName.replace(/'/g, "''")}')`
          ).join(', ');
          await db.query(
            `INSERT INTO entries (race_id, user_id, username) VALUES ${entriesSql}`
          );

          // update remaining_spots (and close if zero)
          const newRemaining = race.remaining_spots - actualClaimed;
          await db.query(
            'UPDATE races SET remaining_spots = $1 WHERE id = $2',
            [newRemaining, race.id]
          );
          if (newRemaining === 0) {
            await db.query(
              'UPDATE races SET closed = true WHERE id = $1',
              [race.id]
            );
          }

          // notifications
          let notificationMessage = `${targetName} claimed ${actualClaimed} spot(s)`;
          if (wasLimited) {
            notificationMessage += ` (only ${actualClaimed} spots were available)`;
          }
          notificationMessage += `. ${newRemaining} spot(s) remaining in race "${race.name}".`;
          
          await message.channel.send(notificationMessage);
          if (newRemaining === 0) {
            await message.channel.send(
              '@here The race is now full! Please sip when available.'
            );
          }
        });
      }

      // Handle "sipped" (now allowed even if race isn't full yet)
      if (['sipped', 'sip', 'sipperood', 'sipd'].includes(content.toLowerCase())) {
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
          const sipped = await db.query('SELECT user_id FROM sips WHERE race_id = $1', [race.id]);
          const vouched = await db.query('SELECT user_id FROM vouches WHERE race_id = $1', [race.id]);
          const coveredIds = new Set([...sipped.rows.map(r => r.user_id), ...vouched.rows.map(r => r.user_id)]);
          const allSipped = entrants.rows.every(e => coveredIds.has(String(e.user_id)));

          if (allSipped && !race.ready_message_sent) {
            await message.channel.send(`@here The race is ready to run!`);
            await db.query('UPDATE races SET ready_message_sent = true WHERE id = $1', [race.id]);
          }
        }
        return;
      }

      // Vouch for someone
      if (content.match(/^vouch\s+for\s+<@!?(\d+)>$/i)) {
        const [, targetId] = content.match(/^vouch\s+for\s+<@!?(\d+)>$/i);
        const { rows } = await db.query('SELECT * FROM races WHERE channel_id = $1 ORDER BY id DESC LIMIT 1', [channelId]);
        if (rows.length === 0) return;
        const race = rows[0];

        const hasEntry = await db.query('SELECT COUNT(*) FROM entries WHERE race_id = $1 AND user_id = $2', [race.id, targetId]);
        if (parseInt(hasEntry.rows[0].count) === 0) return message.reply('That user has no entries in this race.');

        const alreadySipped = await db.query('SELECT * FROM sips WHERE race_id = $1 AND user_id = $2', [race.id, targetId]);
        if (alreadySipped.rows.length > 0) return message.reply('User already sipped.');

        await db.query('INSERT INTO vouches (race_id, user_id, vouched_by) VALUES ($1, $2, $3) ON CONFLICT (race_id, User_id) DO NOTHING', [race.id, targetId, message.author.id]);
        await message.reply(`<@${targetId}> has been vouched for.`);

        if (race.closed) {
          const entrants = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
          const sipped = await db.query('SELECT user_id FROM sips WHERE race_id = $1', [race.id]);
          const vouched = await db.query('SELECT user_id FROM vouches WHERE race_id = $1', [race.id]);
          const coveredIds = new Set([...sipped.rows.map(r => r.user_id), ...vouched.rows.map(r => r.user_id)]);
          const allSipped = entrants.rows.every(e => coveredIds.has(String(e.user_id)));

          if (allSipped && !race.ready_message_sent) {
            await message.channel.send(`@here The race is ready to run!`);
            await db.query('UPDATE races SET ready_message_sent = true WHERE id = $1', [race.id]);
          }
        }
        return;
      }

      // !list <name>
      if (content.toLowerCase().startsWith('!list ')) {
        if (!isCommander) return message.reply('Only a Quack Commander can post the list.');
        const raceName = content.split(' ')[1].toLowerCase();
        const raceRes = await db.query('SELECT * FROM races WHERE channel_id = $1 AND LOWER(name) = $2 ORDER BY id DESC LIMIT 1', [channelId, raceName]);
        if (raceRes.rows.length === 0) return message.reply('Race not found.');

        const race = raceRes.rows[0];
        const entries = await db.query('SELECT username FROM entries WHERE race_id = $1 ORDER BY id ASC', [race.id]);
        if (entries.rows.length === 0) return message.channel.send('No entries yet.');

        // Split entries into chunks to avoid Discord's 2000 character limit
        const header = `Entries for "${race.name}":`;
        const maxLength = 1900; // Leave some buffer for safety
        
        let currentMessage = header;
        let currentNumber = 1;
        
        for (const entry of entries.rows) {
          const entryLine = `\n${currentNumber}. ${entry.username}`;
          
          // If adding this line would exceed the limit, send current message and start a new one
          if ((currentMessage + entryLine).length > maxLength) {
            await message.channel.send(currentMessage);
            currentMessage = header + ` (continued):`;
          }
          
          currentMessage += entryLine;
          currentNumber++;
        }
        
        // Send the final message
        await message.channel.send(currentMessage);
      }

      //Handle !status <name>
      if (content.toLowerCase().startsWith('!status ')) {
        const raceName = content.split(' ')[1].toLowerCase();
        const raceRes = await db.query('SELECT * FROM races WHERE channel_id = $1 AND LOWER(name) = $2 ORDER BY id DESC LIMIT 1', [channelId, raceName]);
        if (raceRes.rows.length === 0) return message.reply('Race not found.');

        const race = raceRes.rows[0];

        const entries = await db.query('SELECT user_id, username, COUNT(*) AS count FROM entries WHERE race_id = $1 GROUP BY user_id, username ORDER BY count DESC', [race.id]);

        const sipped = await db.query('SELECT user_id FROM sips WHERE race_id = $1', [race.id]);
        const sipIds = new Set(sipped.rows.map(r => r.user_id));

        const vouched = await db.query('SELECT user_id, vouched_by FROM vouches WHERE race_id = $1', [race.id]);
        const vouchMap = new Map(vouched.rows.map(r => [r.user_id, r.vouched_by]));

        const statusList = await Promise.all(entries.rows.map(async entry => {
          if (sipIds.has(entry.user_id)) {
            return `✅ ${entry.username} - ${entry.count} - Sipped`;
          } else if (vouchMap.has(entry.user_id)) {
            const vouchedById = vouchMap.get(entry.user_id);
            const vouchedByUser = await message.guild.members.fetch(vouchedById).catch(() => null);
            const vouchedByName = vouchedByUser?.displayName || 'Unknown';
            return `${entry.username} - ${entry.count} - Vouched by ${vouchedByName}`;
          } else {
            return `${entry.username} - ${entry.count}`;
          }
        }));

        return message.channel.send(`Race "${race.name}" Status: ${race.remaining_spots}/${race.total_spots} spots remaining.\n${statusList.join('\n')}`);
      }

      //!remaining - users that still need to sip
      if (content.toLowerCase().startsWith('!remaining')) {
        const parts = content.split(' ');
        if (parts.length < 2) {
          return message.reply('Please provide a race name. Example: `!check myrace`');
        }

        const raceName = parts[1].toLowerCase();
        const raceRes = await db.query(
          'SELECT * FROM races WHERE channel_id = $1 AND LOWER(name) = $2 ORDER BY id DESC LIMIT 1',
          [channelId, raceName]
        );
        if (raceRes.rows.length === 0) return message.reply('Race not found.');

        const race = raceRes.rows[0];
        const allEntries = await db.query('SELECT DISTINCT user_id FROM entries WHERE race_id = $1', [race.id]);
        const sipped = await db.query('SELECT user_id FROM sips WHERE race_id = $1', [race.id]);
        const vouched = await db.query('SELECT user_id FROM vouches WHERE race_id = $1', [race.id]);

        const excluded = new Set([
          ...sipped.rows.map(r => r.user_id),
          ...vouched.rows.map(r => r.user_id),
        ]);

        const unsipped = allEntries.rows.filter(row => !excluded.has(row.user_id));
        if (unsipped.length === 0) return message.channel.send('All participants have sipped or been vouched.');

        const mentions = unsipped.map(row => `<@${row.user_id}>`).join(', ');
        return message.channel.send(`These participants still need to sip or be vouched: ${mentions}`);
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
        await db.query('DELETE FROM sips WHERE race_id = $1', [race.id]);
        await db.query('DELETE FROM vouches WHERE race_id = $1', [race.id]);
        await db.query('UPDATE races SET remaining_spots = total_spots, closed = false, ready_message_sent = false WHERE id = $1', [race.id]);
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
        await db.query('DELETE FROM vouches');
        pendingWipes.delete(channelId);
        return message.channel.send('All race data has been wiped.');
      }

      // !remove @user (Quack Commanders only)
      if (content.toLowerCase().startsWith('!remove ')) {
        if (!isCommander) return message.reply('Only a Quack Commander can remove participants.');

        const mentioned = message.mentions.users.first();
        if (!mentioned) return message.reply('Please mention a user to remove.');

        const raceRes = await db.query(
          'SELECT * FROM races WHERE channel_id = $1 ORDER BY id DESC LIMIT 1',
          [channelId]
        );
        if (raceRes.rows.length === 0) return message.reply('No race found.');

        const race = raceRes.rows[0];

        const deleteRes = await db.query(
          'DELETE FROM entries WHERE race_id = $1 AND user_id = $2 RETURNING *',
          [race.id, mentioned.id]
        );

        if (deleteRes.rows.length === 0) {
          return message.reply(`User <@${mentioned.id}> has no entries in the current race.`);
        }

        const spotsRestored = deleteRes.rows.length;

        // Update race: increase remaining spots and reopen it
        await db.query(
          'UPDATE races SET remaining_spots = remaining_spots + $1, closed = false WHERE id = $2',
          [spotsRestored, race.id]
        );

        return message.channel.send(`Removed ${spotsRestored} spot(s) for <@${mentioned.id}> from race "${race.name}". Race reopened.`);
      }

      // !value <bottlename> [bottlename2] ...
      if (content.toLowerCase().startsWith('!value ')) {
        const bottleNames = content.split(' ').slice(1);
        if (bottleNames.length === 0) {
          return message.reply('Please provide at least one bottle name. Usage: !value <bottlename> [bottlename2] ...');
        }

        let totalValue = 0;
        let responseLines = ['**Bourbon Values:**'];

        for (const bottleName of bottleNames) {
          const result = await db.query(
            'SELECT bottle_name, value FROM bourbon_values WHERE LOWER(bottle_name) = LOWER($1)',
            [bottleName]
          );

          if (result.rows.length > 0) {
            const bottle = result.rows[0];
            const value = parseFloat(bottle.value);
            totalValue += value;
            responseLines.push(`• ${bottle.bottle_name}: $${value.toLocaleString()}`);
          } else {
            responseLines.push(`• ${bottleName}: Not found`);
          }
        }

        responseLines.push(`\n**Total Value: $${totalValue.toLocaleString()}**`);
        return message.channel.send(responseLines.join('\n'));
      }

      // !updatevalue <bottlename> <value>
      if (content.toLowerCase().startsWith('!updatevalue ')) {
        if (!isCommander) return message.reply('Only a Quack Commander can update bourbon values.');

        const parts = content.split(' ');
        if (parts.length < 3) {
          return message.reply('Usage: !updatevalue <bottlename> <value>');
        }

        const bottleName = parts[1];
        const valueStr = parts[2];

        // Remove $ and commas from value
        const cleanValue = valueStr.replace(/[$,]/g, '');
        const value = parseFloat(cleanValue);

        if (isNaN(value) || value < 0) {
          return message.reply('Please provide a valid positive number for the value.');
        }

        // Check if bottle exists
        const existingResult = await db.query(
          'SELECT bottle_name FROM bourbon_values WHERE LOWER(bottle_name) = LOWER($1)',
          [bottleName]
        );

        if (existingResult.rows.length > 0) {
          // Update existing bottle
          await db.query(
            'UPDATE bourbon_values SET value = $1, updated_at = CURRENT_TIMESTAMP WHERE LOWER(bottle_name) = LOWER($2)',
            [value, bottleName]
          );
          return message.channel.send(`Updated value for "${bottleName}" to $${value.toLocaleString()}.`);
        } else {
          // Add new bottle
          await db.query(
            'INSERT INTO bourbon_values (bottle_name, value) VALUES ($1, $2)',
            [bottleName, value]
          );
          return message.channel.send(`Added "${bottleName}" with value $${value.toLocaleString()}.`);
        }
      }
    });

    // Login to Discord
    await client.login(process.env.BOT_TOKEN);
  } catch (error) {
    console.error('Discord bot initialization failed:', error);
    process.exit(1);
  }
}

async function startExpressServer() {
  try {
    const app = express();
    app.get('/', (_, res) => res.send('Bot running'));
    server = app.listen(process.env.PORT || 3000, () => {
      console.log(`Express server listening on port ${process.env.PORT || 3000}`);
    });
  } catch (error) {
    console.error('Express server initialization failed:', error);
    process.exit(1);
  }
}

async function main() {
  try {
    await initializeDatabase();
    await initializeDiscordBot();
    await startExpressServer();
  } catch (error) {
    console.error('Application startup failed:', error);
    process.exit(1);
  }
}

main();
