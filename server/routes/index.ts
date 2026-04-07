import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { router as settingsRouter, setRebuildDemoMap } from './settings.ts';
import { router as catalogRouter } from './catalog.ts';
import { router as devicesRouter } from './devices.ts';
import { router as gasRouter } from './gas.ts';
import { router as projectsRouter } from './projects.ts';
import {
  router as busRouter,
  normalizeDptKey,
  decodeRawValue,
  rebuildDemoMap,
  setBus as setBusImpl,
} from './bus.ts';

import {
  writeKnxFloat16,
  writeBits,
  buildGATable,
  buildAssocTable,
  etsTestMatch,
} from './knx-tables.ts';

import type KnxBusManager from '../knx-bus.ts';

interface AppRouter extends express.Router {
  setBus: (bus: KnxBusManager) => void;
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
router.param(
  'gid',
  (_req: Request, res: Response, next: NextFunction, val: string): void => {
    if (!/^\d+$/.test(val)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    next();
  },
);
router.param(
  'sid',
  (_req: Request, res: Response, next: NextFunction, val: string): void => {
    if (!/^\d+$/.test(val)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    next();
  },
);
router.param(
  'tid',
  (_req: Request, res: Response, next: NextFunction, val: string): void => {
    if (!/^\d+$/.test(val)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    next();
  },
);
router.param(
  'coid',
  (_req: Request, res: Response, next: NextFunction, val: string): void => {
    if (!/^\d+$/.test(val)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    next();
  },
);
router.param(
  'spaceId',
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
setRebuildDemoMap(rebuildDemoMap);

// Inject bus instance (called from server/index.js after creating the instance)
router.setBus = (bus: KnxBusManager): void => {
  setBusImpl(bus);
};

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
