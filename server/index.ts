import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import * as db from './db.ts';
import KnxBusManager from './knx-bus.ts';

const bus = new KnxBusManager();
const PORT = process.env.PORT || 4000;

async function start(): Promise<void> {
  // Must init DB before routes can use it
  await db.init();

  // Lazy-load routes after DB is ready
  const { router: routes } = await import('./routes/index.ts');
  routes.setBus(bus);

  const app = express();
  app.use(cors({ origin: '*' }));
  app.use(express.json());
  app.use('/api', routes);

  // Error handling middleware — catch unhandled route errors
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error('[API] Unhandled error:', err.message);
      res.status(500).json({ error: err.message || 'Internal server error' });
    },
  );

  // Serve built frontend
  const frontendDist = path.join(process.cwd(), 'client', 'dist');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get('*', (_req, res) =>
      res.sendFile(path.join(frontendDist, 'index.html')),
    );
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  bus.attachWSS(wss);

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
  });

  server.listen(PORT, () => {
    console.log(`\n  ⬡  koolenex`);
    console.log(
      `  App:  http://localhost:${String(PORT)}  (after: cd client && npm run build)`,
    );
    console.log(`  API:  http://localhost:${String(PORT)}/api`);
    console.log(`  Dev:  run 'cd client && npx vite' in a second terminal\n`);
  });
}

start().catch((err: unknown) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
