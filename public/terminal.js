const screen = document.getElementById('screen');
const input = document.getElementById('cli-input');
const promptLabel = document.getElementById('prompt');

let currentUser = 'guest';
let currentRoom = null;
let isPasswordMode = false;
let history = [];
let historyIndex = -1;

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}`);

function updatePrompt() {
  if (currentRoom) {
    promptLabel.textContent = `${currentUser}@unix-net:[#${currentRoom}]> `;
  } else {
    promptLabel.textContent = `${currentUser}@unix-net:~$ `;
  }
}

function writeLine(text, className = '') {
  const line = document.createElement('div');
  line.className = `line ${className}`;
  line.textContent = text;
  screen.appendChild(line);
  screen.scrollTop = screen.scrollHeight;
}

function writeHtml(html) {
  const line = document.createElement('div');
  line.className = 'line';
  line.innerHTML = html;
  screen.appendChild(line);
  screen.scrollTop = screen.scrollHeight;
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'output':
      writeLine(msg.text);
      break;

    case 'prompt_password':
      writeLine(msg.text, 'system');
      isPasswordMode = true;
      input.type = 'password';
      break;

    case 'set_user':
      currentUser = msg.text;
      updatePrompt();
      break;

    case 'entered_room':
      currentRoom = ws.lastJoinedRoom;
      updatePrompt();
      writeLine(msg.text, 'system');
      break;

    case 'left_room':
      currentRoom = null;
      updatePrompt();
      writeLine(msg.text, 'system');
      break;

    case 'chat': {
      const timeSpan = `<span class="chat-time">[${msg.time}]</span>`;
      const authorSpan = `<span class="chat-author">&lt;${msg.sender}&gt;</span>`;
      const textSpan = `<span class="chat-msg"> ${escapeHtml(msg.text)}</span>`;
      writeHtml(`${timeSpan} ${authorSpan}${textSpan}`);
      break;
    }

    case 'clear':
      screen.innerHTML = '';
      break;
  }
};

ws.onclose = () => {
  writeLine('\r\n[Connection terminated by host]\r\n', 'error');
  input.disabled = true;
};

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const rawVal = input.value;
    input.value = '';

    if (!isPasswordMode) {
      if (rawVal.trim().length > 0) {
        history.push(rawVal);
        historyIndex = history.length;
      }
      writeLine(`${promptLabel.textContent}${rawVal}`);
    } else {
      writeLine(`${promptLabel.textContent}********`);
    }

    // Check if user is issuing join command to cache target room name
    if (!isPasswordMode && rawVal.trim().toLowerCase().startsWith('join ')) {
      const parts = rawVal.trim().split(/\s+/);
      if (parts[1]) ws.lastJoinedRoom = parts[1].replace(/^#/, '').toLowerCase();
    }

    ws.send(JSON.stringify({ text: rawVal }));

    if (isPasswordMode) {
      isPasswordMode = false;
      input.type = 'text';
    }
  } else if (e.key === 'ArrowUp') {
    if (!isPasswordMode && history.length > 0) {
      if (historyIndex > 0) historyIndex--;
      input.value = history[historyIndex] || '';
    }
  } else if (e.key === 'ArrowDown') {
    if (!isPasswordMode && history.length > 0) {
      if (historyIndex < history.length - 1) {
        historyIndex++;
        input.value = history[historyIndex];
      } else {
        historyIndex = history.length;
        input.value = '';
      }
    }
  }
});

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

// Keep focus active in terminal window on click
document.addEventListener('click', () => input.focus());