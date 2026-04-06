import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createRequire } from 'module';
import { router as settingsRouter, setRebuildDemoMap } from './settings.ts';
import { router as catalogRouter } from './catalog.ts';
import { router as devicesRouter } from './devices.ts';
import { router as gasRouter } from './gas.ts';

// CJS sub-routers not yet converted to TS — use createRequire for interop
// @ts-expect-error TS1470: import.meta is valid at runtime under --experimental-strip-types
const require_ = createRequire(import.meta.url);
const projectsRouter = require_('./projects') as express.Router;
const busRouter = require_('./bus') as express.Router & {
  normalizeDptKey: (key: string) => string;
  decodeRawValue: (...args: unknown[]) => unknown;
  rebuildDemoMap: () => void;
  setBus: (bus: unknown) => void;
};

import {
  writeKnxFloat16,
  writeBits,
  buildGATable,
  buildAssocTable,
  etsTestMatch,
} from './knx-tables.ts';

interface AppRouter extends express.Router {
  setBus: (bus: unknown) => void;
}

const router = express.Router() as AppRouter;

// Validate numeric route params — reject non-numeric :id, :pid, :did with 400
router.param(
  'id',
  (_req: Request, res: Response, next: NextFunction, val: string): void => {
    if (!/^\d+$/.test(val)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    next();
  },
);
router.param(
  'pid',
  (_req: Request, res: Response, next: NextFunction, val: string): void => {
    if (!/^\d+$/.test(val)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    next();
  },
);
router.param(
  'did',
  (_req: Request, res: Response, next: NextFunction, val: string): void => {
    if (!/^\d+$/.test(val)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    next();
  },
);

// Mount sub-routers
router.use('/', settingsRouter);
router.use('/', projectsRouter);
router.use('/', devicesRouter);
router.use('/', gasRouter);
router.use('/', catalogRouter);
router.use('/', busRouter);

// Wire up the rebuildDemoMap dependency: settings needs to call bus.rebuildDemoMap
setRebuildDemoMap(busRouter.rebuildDemoMap);

// Inject bus instance (called from server/index.js after creating the instance)
router.setBus = (bus: unknown): void => {
  busRouter.setBus(bus);
};

// Re-export test helpers so require('../server/routes') still works
const normalizeDptKey = busRouter.normalizeDptKey;
const decodeRawValue = busRouter.decodeRawValue;

export {
  router,
  writeKnxFloat16,
  writeBits,
  normalizeDptKey,
  decodeRawValue,
  buildGATable,
  buildAssocTable,
  etsTestMatch,
};
