'use strict';
const express = require('express');

const settingsRouter = require('./settings');
const projectsRouter = require('./projects');
const devicesRouter = require('./devices');
const gasRouter = require('./gas');
const catalogRouter = require('./catalog');
const busRouter = require('./bus');
const knxTables = require('./knx-tables.ts');

const router = express.Router();

// Validate numeric route params — reject non-numeric :id, :pid, :did with 400
router.param('id', (req, res, next, val) => {
  if (!/^\d+$/.test(val)) return res.status(400).json({ error: 'Invalid ID' });
  next();
});
router.param('pid', (req, res, next, val) => {
  if (!/^\d+$/.test(val)) return res.status(400).json({ error: 'Invalid ID' });
  next();
});
router.param('did', (req, res, next, val) => {
  if (!/^\d+$/.test(val)) return res.status(400).json({ error: 'Invalid ID' });
  next();
});

// Mount sub-routers
router.use('/', settingsRouter);
router.use('/', projectsRouter);
router.use('/', devicesRouter);
router.use('/', gasRouter);
router.use('/', catalogRouter);
router.use('/', busRouter);

// Wire up the rebuildDemoMap dependency: settings needs to call bus.rebuildDemoMap
settingsRouter.setRebuildDemoMap(busRouter.rebuildDemoMap);

// Inject bus instance (called from server/index.js after creating the instance)
router.setBus = (bus) => {
  busRouter.setBus(bus);
};

module.exports = router;

// Re-export test helpers so require('../server/routes') still works
module.exports.writeKnxFloat16 = knxTables.writeKnxFloat16;
module.exports.writeBits = knxTables.writeBits;
module.exports.normalizeDptKey = busRouter.normalizeDptKey;
module.exports.decodeRawValue = busRouter.decodeRawValue;
module.exports.buildGATable = knxTables.buildGATable;
module.exports.buildAssocTable = knxTables.buildAssocTable;
module.exports.etsTestMatch = knxTables.etsTestMatch;
