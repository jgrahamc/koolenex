import express from 'express';
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

// Numeric route parameters are validated by paramId() in validate.ts, at
// the point of use. Eight identical `router.param` validators used to live
// here instead - and never ran: Express scopes param callbacks to the
// router that declares them, and every route carrying an id is in one of
// the sub-routers mounted below. Nothing asserted them, so the dead code
// sat here while malformed ids reached the handlers. See
// tests/param-validation.test.ts.

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
