A retro Unix terminal-style web chat room environment built with Node.js, native WebSockets, and SQLite.

## Features
- Simulated Unix command-line shell interface (`adduser`, `login`, `ls`, `join`)
- Persistent user accounts with salted scrypt password hashing
- Isolated community chat rooms with dynamic occupancy tracking
- Strict 10-user concurrency limit per room
- Built on native `node:sqlite` (zero C++ build tool dependencies)

## Quick Start
```bash
npm install
npm start