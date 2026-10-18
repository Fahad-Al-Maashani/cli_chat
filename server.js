import { loadEnvFile } from 'node:process';

// Load .env automatically if present locally
try {
  loadEnvFile();
} catch {
  // .env file not found; fallback to process-level environment variables
}

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Externalized environment configuration
const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || 'data.db';
const MAX_USERS_PER_ROOM = parseInt(process.env.MAX_ROOM_USERS || '10', 10);

// Initialize SQLite database via environment path in WAL mode
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

// Initialize schema and default community entries
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS communities (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    description TEXT
  );

  INSERT OR IGNORE INTO communities (name, description) VALUES
    ('general', 'General discussions and lobby'),
    ('dev', 'Software engineering, tools, and algorithms'),
    ('sysadmin', 'Linux, networking, and cloud infrastructure'),
    ('hardware', 'Embedded systems, FPGA, and circuits');
`);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

// In-memory room registry: roomName -> Set<WebSocket>
const rooms = new Map();
const dbRooms = db.prepare('SELECT name FROM communities').all();
for (const r of dbRooms) {
  rooms.set(r.name.toLowerCase(), new Set());
}

// Prepared database queries
const stmtGetUser = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtCreateUser = db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)');
const stmtListCommunities = db.prepare('SELECT name, description FROM communities');

// Express application & HTTP static asset delivery
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server });

function send(ws, text, type = 'output') {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, text }));
  }
}

function broadcastToRoom(roomName, senderName, text, excludeWs = null) {
  const room = rooms.get(roomName.toLowerCase());
  if (!room) return;
  const payload = JSON.stringify({
    type: 'chat',
    room: roomName,
    sender: senderName,
    text,
    time: new Date().toLocaleTimeString()
  });

  for (const client of room) {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  ws.session = {
    user: null,
    room: null,
    pendingAction: null,
    tempData: {}
  };

  send(ws, "Connected to Unix Network Environment v2.4\r\nType 'help' to inspect available system commands.\r\n");

  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const input = (payload.text || '').trim();

    // 1. Password capture prompts
    if (ws.session.pendingAction) {
      handlePendingAction(ws, input);
      return;
    }

    // 2. Active chat room message processing
    if (ws.session.room) {
      if (input === '/exit' || input === '/leave' || input === 'exit') {
        leaveCurrentRoom(ws);
        return;
      }
      if (input.startsWith('/')) {
        send(ws, "In room mode. Use '/exit' to return to system CLI.");
        return;
      }
      if (input.length > 0) {
        broadcastToRoom(ws.session.room, ws.session.user.username, input);
      }
      return;
    }

    // 3. Command interpreter
    handleShellCommand(ws, input);
  });

  ws.on('close', () => {
    if (ws.session.room) {
      leaveCurrentRoom(ws);
    }
  });
});

function handlePendingAction(ws, input) {
  const action = ws.session.pendingAction;

  if (action === 'LOGIN_PASSWORD') {
    const { username } = ws.session.tempData;
    ws.session.pendingAction = null;
    ws.session.tempData = {};

    const user = stmtGetUser.get(username);
    if (!user) {
      send(ws, 'Authentication failed: user record not found.');
      return;
    }

    const testHash = hashPassword(input, user.salt);
    if (crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(user.password_hash, 'hex'))) {
      ws.session.user = { id: user.id, username: user.username };
      send(ws, `Access granted. Logged in as '${user.username}'.`);
      send(ws, user.username, 'set_user');
    } else {
      send(ws, 'Access denied: incorrect credentials.');
    }
    return;
  }

  if (action === 'REGISTER_PASSWORD') {
    const { username } = ws.session.tempData;
    ws.session.pendingAction = null;
    ws.session.tempData = {};

    if (input.length < 5) {
      send(ws, 'Registration failed: password must be at least 5 characters long.');
      return;
    }

    try {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(input, salt);
      stmtCreateUser.run(username, hash, salt);
      send(ws, `User account '${username}' created successfully. Run 'login ${username}' to authenticate.`);
    } catch (err) {
      send(ws, `Failed to create user: ${err.message}`);
    }
    return;
  }
}

function handleShellCommand(ws, commandLine) {
  if (!commandLine) return;

  const [cmd, ...args] = commandLine.split(/\s+/);
  const command = cmd.toLowerCase();

  switch (command) {
    case 'help':
    case 'man':
      send(ws, [
        'Available Unix Commands:',
        '  adduser <name>       Create a new user account on this system',
        '  login <name>         Authenticate into an existing account',
        '  logout               Terminate current session',
        '  whoami               Display current session user',
        '  ls / communities     List available chat communities & occupancy',
        `  join <name>          Join community chat (max ${MAX_USERS_PER_ROOM} users per room)`,
        '  clear                Clear terminal screen',
        '  exit / /leave        Exit an active chat session back to shell'
      ].join('\r\n'));
      break;

    case 'adduser':
    case 'useradd': {
      const username = args[0];
      if (!username || !/^[a-zA-Z0-9_-]{3,16}$/.test(username)) {
        send(ws, 'Usage: adduser <username> (3-16 alphanumeric chars, dashes, underscores)');
        return;
      }
      const existing = stmtGetUser.get(username);
      if (existing) {
        send(ws, `Error: user '${username}' already exists.`);
        return;
      }
      ws.session.pendingAction = 'REGISTER_PASSWORD';
      ws.session.tempData = { username };
      send(ws, 'Enter password for new account:', 'prompt_password');
      break;
    }

    case 'login': {
      const username = args[0];
      if (!username) {
        send(ws, 'Usage: login <username>');
        return;
      }
      const user = stmtGetUser.get(username);
      if (!user) {
        send(ws, `User '${username}' does not exist. Use 'adduser ${username}' first.`);
        return;
      }
      ws.session.pendingAction = 'LOGIN_PASSWORD';
      ws.session.tempData = { username };
      send(ws, `Password for ${username}:`, 'prompt_password');
      break;
    }

    case 'whoami':
      if (ws.session.user) {
        send(ws, `${ws.session.user.username}`);
      } else {
        send(ws, 'guest (unauthenticated)');
      }
      break;

    case 'logout':
      if (!ws.session.user) {
        send(ws, 'Not currently logged in.');
      } else {
        const oldUser = ws.session.user.username;
        ws.session.user = null;
        send(ws, `User '${oldUser}' logged out.`);
        send(ws, 'guest', 'set_user');
      }
      break;

    case 'ls':
    case 'communities': {
      const list = stmtListCommunities.all();
      const rows = list.map((c) => {
        const count = rooms.get(c.name.toLowerCase())?.size || 0;
        const status = count >= MAX_USERS_PER_ROOM ? '[FULL]' : '[OPEN]';
        return `  #${c.name.padEnd(12)} (${count}/${MAX_USERS_PER_ROOM}) ${status} - ${c.description}`;
      });
      send(ws, `Available Communities:\r\n${rows.join('\r\n')}`);
      break;
    }

    case 'join':
    case 'cd': {
      if (!ws.session.user) {
        send(ws, "Authentication required. Run 'login <username>' or 'adduser <username>' to join rooms.");
        return;
      }
      let targetRoom = args[0] ? args[0].replace(/^#/, '').toLowerCase() : null;
      if (!targetRoom || !rooms.has(targetRoom)) {
        send(ws, "Usage: join <room_name>. Run 'ls' to see existing communities.");
        return;
      }
      const roomSet = rooms.get(targetRoom);
      if (roomSet.size >= MAX_USERS_PER_ROOM) {
        send(ws, `Access rejected: Community '#${targetRoom}' is at max capacity (${MAX_USERS_PER_ROOM}/${MAX_USERS_PER_ROOM}).`);
        return;
      }

      roomSet.add(ws);
      ws.session.room = targetRoom;
      send(ws, `Entered community '#${targetRoom}'. You are now in live chat mode.\r\nMessages will broadcast to this room. Type '/exit' to return to CLI.`, 'entered_room');
      broadcastToRoom(targetRoom, 'SYSTEM', `* ${ws.session.user.username} entered the room. (${roomSet.size}/${MAX_USERS_PER_ROOM})`, ws);
      break;
    }

    case 'clear':
      send(ws, '', 'clear');
      break;

    default:
      send(ws, `bash: ${command}: command not found. Type 'help' for available commands.`);
  }
}

function leaveCurrentRoom(ws) {
  const roomName = ws.session.room;
  if (!roomName) return;

  const roomSet = rooms.get(roomName.toLowerCase());
  if (roomSet) {
    roomSet.delete(ws);
    broadcastToRoom(roomName, 'SYSTEM', `* ${ws.session.user.username} left the room. (${roomSet.size}/${MAX_USERS_PER_ROOM})`);
  }
  ws.session.room = null;
  send(ws, `Exited '#${roomName}'. Returned to main CLI.`, 'left_room');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Unix Web CLI Chat listening on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH} | Max room capacity: ${MAX_USERS_PER_ROOM}`);
});
