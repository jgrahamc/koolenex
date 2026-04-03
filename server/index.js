'use strict';
const express = require('express');
const cors    = require('cors');
const http    = require('http');
const { WebSocketServer } = require('ws');
const path    = require('path');
const fs      = require('fs');
const db      = require('./db');
const KnxBusManager = require('./knx-bus');
const bus     = new KnxBusManager();

const PORT = process.env.PORT || 4000;

async function start() {
  // Must init DB before routes can use it
  await db.init();

  // Lazy-load routes after DB is ready
  const routes = require('./routes');
  routes.setBus(bus);

  const app = express();
  app.use(cors({ origin: '*' }));
  app.use(express.json());
  app.use('/api', routes);

  // Serve built frontend
  const frontendDist = path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get('*', (req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  bus.attachWSS(wss);

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
  });

  server.listen(PORT, () => {
    console.log(`\n  ⬡  koolenex`);
    console.log(`  App:  http://localhost:${PORT}  (after: cd client && npm run build)`);
    console.log(`  API:  http://localhost:${PORT}/api`);
    console.log(`  Dev:  run 'cd client && npx vite' in a second terminal\n`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
