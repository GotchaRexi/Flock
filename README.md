# Duck Race Bot

A Discord bot for managing bourbon bottle races with spot claiming, sipping tracking, and value management.

## Recent Deployment Fixes

The bot has been updated to fix SIGTERM deployment errors by:

1. **Removed top-level await**: All database initialization and bot setup is now properly wrapped in async functions
2. **Added graceful shutdown handling**: The bot now properly handles SIGTERM and SIGINT signals
3. **Improved error handling**: Database connection failures and other errors are now properly caught and logged
4. **Structured initialization**: The bot now initializes in a proper sequence: database → Discord bot → Express server

## Environment Variables

Create a `.env` file with the following variables:

```
# Discord Bot Token
BOT_TOKEN=your_discord_bot_token_here

# Database Connection String
DATABASE_URL=postgresql://username:password@host:port/database_name

# Optional: Port for Express server (defaults to 3000)
PORT=3000
```

## Commands

- `!start <name> <spots>` — Start a new race (Quack Commanders only)
- `x<number>` — Claim spots in the active race
- `x<number> for @user` — Claim spots for someone else
- `sipped` — Mark yourself as sipped once race is full
- `vouch for @user` — Mark someone else as vouched
- `!list <name>` — Show all individual entries in a race
- `!status <name>` — Show current summary of the race
- `!remaining <name>` — List users who haven't sipped or vouched
- `!remove <@user>` — Remove a user from the race and reopen the race if it was closed
- `!cancel <name>` — Cancel an active race (Quack Commanders only)
- `!reset <name>` — Clear all entries from a race (Quack Commanders only)
- `!forceclose <name>` — Force a race to close early (Quack Commanders only)
- `!value <bottlename> [bottlename2] ...` — List values for specified bourbons
- `!updatevalue <bottlename> <value>` — Update or add a bourbon value (Quack Commanders only)
- `!retire` — Retire from racing (no more entries allowed)
- `!unretire` — Unretire and return to racing

## Installation

1. Install dependencies: `npm install`
2. Set up environment variables
3. Run the bot: `npm start`

## Deployment

The bot is now properly configured for deployment platforms like Railway, Heroku, or similar services. The graceful shutdown handling ensures the bot can be properly stopped and restarted without data corruption.
