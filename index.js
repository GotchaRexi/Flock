// index.js
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from 'dotenv';
import pkg from 'pg';
import express from 'express';

config();

const { Client: PGClient } = pkg;
const pendingClaims = new Set();
const pendingWipes = new Map();

// Queue system for processing claims in order per channel
const claimQueues = new Map(); // channelId -> queue of pending claims

// Process a claim queue for a channel
async function processClaimQueue(channelId) {
  const queue = claimQueues.get(channelId);
  if (!queue || queue.processing || queue.items.length === 0) {
    return;
  }

  queue.processing = true;

  while (queue.items.length > 0) {
    const claim = queue.items.shift();
    try {
      await claim.process();
      if (claim.resolve) {
        claim.resolve();
      }
    } catch (error) {
      console.error('Error processing claim:', error);
      if (claim.reject) {
        claim.reject(error);
      } else if (claim.message) {
        claim.message.reply('An error occurred while processing your claim. Please try again.').catch(() => {});
      }
    }
  }

  queue.processing = false;
  
  // Clean up empty queues
  if (queue.items.length === 0) {
    claimQueues.delete(channelId);
  }
}

// Add a claim to the queue
function queueClaim(channelId, processFn, message) {
  return new Promise((resolve, reject) => {
    if (!claimQueues.has(channelId)) {
      claimQueues.set(channelId, { items: [], processing: false });
    }

    const queue = claimQueues.get(channelId);
    queue.items.push({ 
      process: processFn, 
      message,
      resolve,
      reject
    });

    // Start processing if not already processing
    if (!queue.processing) {
      // Use setImmediate to allow the current execution to complete
      setImmediate(() => processClaimQueue(channelId));
    }
  });
}

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

    // Create voice monitoring table
    await db.query(`
      CREATE TABLE IF NOT EXISTS voice_tracking (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_time_minutes INTEGER DEFAULT 0,
        speaking_time_minutes INTEGER DEFAULT 0,
        is_muted BOOLEAN DEFAULT FALSE,
        muted_at TIMESTAMP,
        PRIMARY KEY (user_id, guild_id)
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
      intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates // Needed for voice monitoring
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction]
    });

    client.once('ready', async () => {
      console.log(`Logged in as ${client.user.tag}`);
      
      // Check existing voice members on startup
      for (const guild of client.guilds.cache.values()) {
        for (const [memberId, member] of guild.members.cache) {
          if (member.voice.channel && !member.voice.mute) {
            const userId = member.id;
            const guildId = guild.id;
            
            // Initialize tracking if not exists
            await db.query(`
              INSERT INTO voice_tracking (user_id, guild_id, joined_at)
              VALUES ($1, $2, CURRENT_TIMESTAMP)
              ON CONFLICT (user_id, guild_id) 
              DO UPDATE SET joined_at = CURRENT_TIMESTAMP
            `, [userId, guildId]).catch(() => {});
            
            voiceJoinTimes.set(`${guildId}-${userId}`, Date.now());
          }
        }
      }
      
      // Periodic check every 5 minutes for users who should be muted
      setInterval(async () => {
        for (const guild of client.guilds.cache.values()) {
          for (const [memberId, member] of guild.members.cache) {
            if (member.voice.channel && !member.voice.mute && !member.voice.deaf && !member.user.bot) {
              const userId = member.id;
              const guildId = guild.id;
              const joinTime = voiceJoinTimes.get(`${guildId}-${userId}`);
              const speakingStart = speakingStartTimes.get(`${guildId}-${userId}`);
              
              if (joinTime) {
                const timeInVoice = Math.floor((Date.now() - joinTime) / 60000);
                const currentSpeakingTime = speakingStart ? Math.floor((Date.now() - speakingStart) / 60000) : 0;
                
                const timeResult = await db.query(`
                  SELECT total_time_minutes, speaking_time_minutes FROM voice_tracking 
                  WHERE user_id = $1 AND guild_id = $2
                `, [userId, guildId]);
                
                const totalTime = (timeResult.rows[0]?.total_time_minutes || 0) + timeInVoice;
                const totalSpeakingTime = (timeResult.rows[0]?.speaking_time_minutes || 0) + currentSpeakingTime;
                
                const shouldMute = totalSpeakingTime >= speakingMuteThreshold || totalTime >= voiceMuteThreshold;
                
                if (shouldMute) {
                  try {
                    const reason = totalSpeakingTime >= speakingMuteThreshold 
                      ? `Auto-muted: Talking too much (${totalSpeakingTime} minutes)`
                      : `Auto-muted: Too much time in voice chat (${totalTime} minutes)`;
                    
                    await member.voice.setMute(true, reason);
                    await db.query(`
                      UPDATE voice_tracking 
                      SET is_muted = TRUE, muted_at = CURRENT_TIMESTAMP
                      WHERE user_id = $1 AND guild_id = $2
                    `, [userId, guildId]);
                  } catch (error) {
                    console.error('Error muting user:', error);
                  }
                }
              }
            }
          }
        }
      }, 5 * 60 * 1000); // Check every 5 minutes
    });

    // Voice state tracking
    const voiceJoinTimes = new Map(); // user_id -> join timestamp
    const speakingStartTimes = new Map(); // user_id -> when they started speaking (not muted/deafened)
    let voiceMuteThreshold = 120; // minutes in voice before auto-mute (default 2 hours)
    let speakingMuteThreshold = 60; // minutes of active speaking before auto-mute (default 1 hour)

    // Track voice state changes
    client.on('voiceStateUpdate', async (oldState, newState) => {
      const userId = newState.member.id;
      const guildId = newState.guild.id;
      const member = newState.member;

      // User joined a voice channel
      if (!oldState.channelId && newState.channelId) {
        voiceJoinTimes.set(`${guildId}-${userId}`, Date.now());
        // Start tracking speaking time if not muted/deafened
        if (!newState.mute && !newState.deaf) {
          speakingStartTimes.set(`${guildId}-${userId}`, Date.now());
        }
        await db.query(`
          INSERT INTO voice_tracking (user_id, guild_id, joined_at)
          VALUES ($1, $2, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, guild_id) 
          DO UPDATE SET joined_at = CURRENT_TIMESTAMP, is_muted = FALSE
        `, [userId, guildId]);
      }

      // User left a voice channel
      if (oldState.channelId && !newState.channelId) {
        const joinTime = voiceJoinTimes.get(`${guildId}-${userId}`);
        const speakingStart = speakingStartTimes.get(`${guildId}-${userId}`);
        
        if (joinTime) {
          const timeInVoice = Math.floor((Date.now() - joinTime) / 60000); // minutes
          voiceJoinTimes.delete(`${guildId}-${userId}`);
          
          let speakingTime = 0;
          if (speakingStart) {
            speakingTime = Math.floor((Date.now() - speakingStart) / 60000);
            speakingStartTimes.delete(`${guildId}-${userId}`);
          }
          
          await db.query(`
            UPDATE voice_tracking 
            SET total_time_minutes = total_time_minutes + $1,
                speaking_time_minutes = speaking_time_minutes + $4
            WHERE user_id = $2 AND guild_id = $3
          `, [timeInVoice, userId, guildId, speakingTime]);
        }
      }

      // User started speaking (unmuted/undeafened)
      if (newState.channelId && (oldState.mute !== newState.mute || oldState.deaf !== newState.deaf)) {
        if (!newState.mute && !newState.deaf && (oldState.mute || oldState.deaf)) {
          // User just unmuted/undeafened - start tracking speaking time
          speakingStartTimes.set(`${guildId}-${userId}`, Date.now());
        } else if ((newState.mute || newState.deaf) && !oldState.mute && !oldState.deaf) {
          // User just muted/deafened - stop tracking and save speaking time
          const speakingStart = speakingStartTimes.get(`${guildId}-${userId}`);
          if (speakingStart) {
            const speakingTime = Math.floor((Date.now() - speakingStart) / 60000);
            speakingStartTimes.delete(`${guildId}-${userId}`);
            
            await db.query(`
              UPDATE voice_tracking 
              SET speaking_time_minutes = speaking_time_minutes + $1
              WHERE user_id = $2 AND guild_id = $3
            `, [speakingTime, userId, guildId]);
          }
        }
      }

      // Check if user should be auto-muted (speaking time or total time)
      if (newState.channelId && !newState.mute && !newState.deaf) {
        const joinTime = voiceJoinTimes.get(`${guildId}-${userId}`);
        const speakingStart = speakingStartTimes.get(`${guildId}-${userId}`);
        
        if (joinTime) {
          const timeInVoice = Math.floor((Date.now() - joinTime) / 60000);
          const currentSpeakingTime = speakingStart ? Math.floor((Date.now() - speakingStart) / 60000) : 0;
          
          // Get totals from database
          const timeResult = await db.query(`
            SELECT total_time_minutes, speaking_time_minutes FROM voice_tracking 
            WHERE user_id = $1 AND guild_id = $2
          `, [userId, guildId]);
          
          const totalTime = (timeResult.rows[0]?.total_time_minutes || 0) + timeInVoice;
          const totalSpeakingTime = (timeResult.rows[0]?.speaking_time_minutes || 0) + currentSpeakingTime;
          
          // Auto-mute if over speaking threshold (talking too much) OR total time threshold
          const shouldMute = totalSpeakingTime >= speakingMuteThreshold || totalTime >= voiceMuteThreshold;
          
          if (shouldMute && member.voice && !member.voice.mute) {
            try {
              const reason = totalSpeakingTime >= speakingMuteThreshold 
                ? `Auto-muted: Talking too much (${totalSpeakingTime} minutes of speaking time)`
                : `Auto-muted: Too much time in voice chat (${totalTime} minutes)`;
              
              await member.voice.setMute(true, reason);
              await db.query(`
                UPDATE voice_tracking 
                SET is_muted = TRUE, muted_at = CURRENT_TIMESTAMP
                WHERE user_id = $1 AND guild_id = $2
              `, [userId, guildId]);
              
              // Notify in a channel
              const channel = newState.guild.channels.cache.find(
                ch => ch.type === 0 && ch.name.toLowerCase().includes('general')
              );
              if (channel) {
                const message = totalSpeakingTime >= speakingMuteThreshold
                  ? `🔇 Auto-muted <@${userId}> - they've been talking for ${totalSpeakingTime} minutes.`
                  : `🔇 Auto-muted <@${userId}> - they've been in voice chat for ${totalTime} minutes.`;
                channel.send(message).catch(() => {});
              }
            } catch (error) {
              console.error('Error muting user:', error);
            }
          }
        }
      }
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
!unretire — Unretire and return to racing

**Voice Monitoring Commands:**
!voicestats [@user] — Check voice chat time and speaking time for a user
!unmute <@user> — Manually unmute a user (Quack Commanders only)
!mutetime <minutes> — Set total time mute threshold (Quack Commanders only)
!speakingtime <minutes> — Set speaking time mute threshold - mutes when talking too much (Quack Commanders only)
!mutelist — List all currently muted users`);
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
      // Queue-based claim processing
      // --------------------
      function queueClaimExclusive(channelId, message, fn) {
        return queueClaim(channelId, fn, message);
      }

      // --------------------
      // Handle "x close"
      // --------------------
      const xCloseMatch = content.match(/^x\s*close$/i);
      if (xCloseMatch) {
        return queueClaimExclusive(channelId, message, async () => {
          // Check if user is retired
          const retiredCheck = await db.query('SELECT * FROM retired_users WHERE user_id = $1', [message.author.id]);
          if (retiredCheck.rows.length > 0) {
            return message.reply('You are retired from races. Please take a moment to evaluate your choices');
          }

          // Use transaction with SELECT FOR UPDATE to ensure atomicity
          await db.query('BEGIN');
          try {
            // 1) fetch latest open race with row lock
            const { rows } = await db.query(
              'SELECT id, remaining_spots FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1 FOR UPDATE',
              [channelId]
            );
            if (!rows.length) {
              // Check if a closed race exists to provide better error message
              const raceCheck = await db.query(
                'SELECT * FROM races WHERE channel_id = $1 ORDER BY id DESC LIMIT 1',
                [channelId]
              );
              await db.query('ROLLBACK');
              if (raceCheck.rows.length && raceCheck.rows[0].closed) {
                return message.reply('The race is full. No spots remaining.');
              }
              return;
            }

            const { id: raceId, remaining_spots: count } = rows[0];
            if (count <= 0) {
              await db.query('ROLLBACK');
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

            await db.query('COMMIT');

            // 5) notify channel
            await message.channel.send('@here The race is now full! Please sip when available.');
          } catch (error) {
            await db.query('ROLLBACK');
            throw error;
          }
        });
      }

      // --------------------
      // Handle "x<number>" and "x<number> for @user"
      // --------------------
      const claimMatch = content.match(/^x(\d+)(?:\s+for\s+<@!?(\d+)>)?/i);
      if (claimMatch) {
        return queueClaimExclusive(channelId, message, async () => {
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

          // Use transaction with SELECT FOR UPDATE to ensure atomicity
          await db.query('BEGIN');
          try {
            // fetch the open race with row lock
            const { rows } = await db.query(
              'SELECT * FROM races WHERE channel_id = $1 AND closed = false ORDER BY id DESC LIMIT 1 FOR UPDATE',
              [channelId]
            );
            if (!rows.length) {
              // Check if a closed race exists to provide better error message
              const raceCheck = await db.query(
                'SELECT * FROM races WHERE channel_id = $1 ORDER BY id DESC LIMIT 1',
                [channelId]
              );
              await db.query('ROLLBACK');
              if (raceCheck.rows.length && raceCheck.rows[0].closed) {
                return message.reply('The race is full. No spots remaining.');
              }
              return;
            }

            const race = rows[0];
            
            // If they want more spots than available, give them all remaining spots
            const actualClaimed = Math.min(want, race.remaining_spots);
            const wasLimited = want > race.remaining_spots;

            if (actualClaimed <= 0) {
              await db.query('ROLLBACK');
              return message.reply('There are no remaining spots to claim.');
            }

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
              'UPDATE races SET remaining_spots = $1, closed = CASE WHEN $1 = 0 THEN true ELSE closed END WHERE id = $2',
              [newRemaining, race.id]
            );

            await db.query('COMMIT');

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
          } catch (error) {
            await db.query('ROLLBACK');
            throw error;
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
        if (targetId === message.author.id) {
          return message.reply("You can no longer vouch for yourself, it doesn't make any sense. Please stop trying to find ways to beat the system.");
        }
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

        // Split status into chunks to avoid Discord's 2000 character limit
        const header = `Race "${race.name}" Status: ${race.remaining_spots}/${race.total_spots} spots remaining.`;
        const maxLength = 1900; // Leave some buffer for safety
        
        let currentMessage = header;
        
        for (const statusLine of statusList) {
          const statusLineWithNewline = `\n${statusLine}`;
          
          // If adding this line would exceed the limit, send current message and start a new one
          if ((currentMessage + statusLineWithNewline).length > maxLength) {
            await message.channel.send(currentMessage);
            currentMessage = header + ` (continued):`;
          }
          
          currentMessage += statusLineWithNewline;
        }
        
        // Send the final message
        await message.channel.send(currentMessage);
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

      // Voice monitoring commands
      // !voicestats [@user] - Check voice chat time
      if (content.toLowerCase().startsWith('!voicestats')) {
        const mentioned = message.mentions.users.first();
        const targetId = mentioned ? mentioned.id : message.author.id;
        const targetName = mentioned ? mentioned.displayName : message.member.displayName;

        const stats = await db.query(`
          SELECT total_time_minutes, speaking_time_minutes, is_muted, muted_at, joined_at
          FROM voice_tracking
          WHERE user_id = $1 AND guild_id = $2
        `, [targetId, message.guild.id]);

        if (stats.rows.length === 0) {
          return message.reply(`${targetName} hasn't been tracked in voice chat yet.`);
        }

        const stat = stats.rows[0];
        const totalHours = Math.floor(stat.total_time_minutes / 60);
        const totalMinutes = stat.total_time_minutes % 60;
        const speakingHours = Math.floor((stat.speaking_time_minutes || 0) / 60);
        const speakingMinutes = (stat.speaking_time_minutes || 0) % 60;
        const status = stat.is_muted ? '🔇 Muted' : '✅ Active';
        
        return message.channel.send(
          `**Voice Stats for ${targetName}:**\n` +
          `Total time in voice: ${totalHours}h ${totalMinutes}m\n` +
          `Speaking time (active): ${speakingHours}h ${speakingMinutes}m\n` +
          `Status: ${status}\n` +
          `Speaking threshold: ${speakingMuteThreshold} min | Total threshold: ${voiceMuteThreshold} min`
        );
      }

      // !unmute <@user> - Manually unmute someone (Quack Commanders only)
      if (content.toLowerCase().startsWith('!unmute ')) {
        if (!isCommander) return message.reply('Only a Quack Commander can unmute users.');
        
        const mentioned = message.mentions.members.first();
        if (!mentioned) return message.reply('Please mention a user to unmute.');

        try {
          if (mentioned.voice && mentioned.voice.mute) {
            await mentioned.voice.setMute(false, 'Manually unmuted by Quack Commander');
            await db.query(`
              UPDATE voice_tracking 
              SET is_muted = FALSE, muted_at = NULL
              WHERE user_id = $1 AND guild_id = $2
            `, [mentioned.id, message.guild.id]);
            return message.channel.send(`🔊 Unmuted <@${mentioned.id}>.`);
          } else {
            return message.reply('That user is not currently muted.');
          }
        } catch (error) {
          console.error('Error unmuting user:', error);
          return message.reply('Failed to unmute user. Make sure the bot has permission to manage voice states.');
        }
      }

      // !mutetime <minutes> - Set total time mute threshold (Quack Commanders only)
      if (content.toLowerCase().startsWith('!mutetime ')) {
        if (!isCommander) return message.reply('Only a Quack Commander can set the mute threshold.');
        
        const parts = content.split(' ');
        if (parts.length < 2) {
          return message.reply('Usage: !mutetime <minutes>');
        }

        const minutes = parseInt(parts[1]);
        if (isNaN(minutes) || minutes <= 0) {
          return message.reply('Please provide a valid positive number of minutes.');
        }

        voiceMuteThreshold = minutes;
        return message.channel.send(`Total time mute threshold set to ${minutes} minutes. Users will be auto-muted after this much total time in voice chat.`);
      }

      // !speakingtime <minutes> - Set speaking time mute threshold (Quack Commanders only)
      if (content.toLowerCase().startsWith('!speakingtime ')) {
        if (!isCommander) return message.reply('Only a Quack Commander can set the speaking threshold.');
        
        const parts = content.split(' ');
        if (parts.length < 2) {
          return message.reply('Usage: !speakingtime <minutes>');
        }

        const minutes = parseInt(parts[1]);
        if (isNaN(minutes) || minutes <= 0) {
          return message.reply('Please provide a valid positive number of minutes.');
        }

        speakingMuteThreshold = minutes;
        return message.channel.send(`Speaking time mute threshold set to ${minutes} minutes. Users will be auto-muted when they talk for this long (while unmuted/undeafened).`);
      }

      // !mutelist - List all currently muted users
      if (content.toLowerCase() === '!mutelist') {
        const muted = await db.query(`
          SELECT user_id, total_time_minutes, muted_at
          FROM voice_tracking
          WHERE guild_id = $1 AND is_muted = TRUE
          ORDER BY muted_at DESC
        `, [message.guild.id]);

        if (muted.rows.length === 0) {
          return message.channel.send('No users are currently muted.');
        }

        const mutedList = await Promise.all(muted.rows.map(async (row) => {
          const user = await message.guild.members.fetch(row.user_id).catch(() => null);
          const hours = Math.floor(row.total_time_minutes / 60);
          const minutes = row.total_time_minutes % 60;
          return `• ${user?.displayName || 'Unknown'}: ${hours}h ${minutes}m total`;
        }));

        return message.channel.send(`**Currently Muted Users:**\n${mutedList.join('\n')}`);
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
