import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import * as db from '../db.ts';
import { buildGAMaps } from '../../shared/ga-maps.ts';
import { validateBody, paramId } from '../validate.ts';
import { makeUpdateBuilder } from './shared.ts';
import { invalidateGaDptCache } from './bus.ts';
import type {
  GroupAddress,
  GaGroupName,
  EnrichedGA,
  ComObjectWithDevice,
} from '../../shared/types.ts';

const router = express.Router();

// ── Group Addresses ───────────────────────────────────────────────────────────
router.get('/projects/:id/gas', (req: Request, res: Response): void => {
  const pid = paramId(req, 'id');
  const gas = db.all<GroupAddress>(
    'SELECT * FROM group_addresses WHERE project_id=? ORDER BY main_g,middle_g,sub_g',
    [pid],
  );
  // Derive device<->GA map from com_objects
  const cos = db.all<ComObjectWithDevice>(
    `SELECT co.ga_address, d.individual_address as device_address, d.name as device_name FROM com_objects co JOIN devices d ON co.device_id=d.id WHERE co.project_id=?`,
    [pid],
  );
  const { gaDeviceMap } = buildGAMaps(cos);

  // Attach group names from dedicated table
  const groupNames = db.all<GaGroupName>(
    'SELECT main_g, middle_g, name FROM ga_group_names WHERE project_id=?',
    [pid],
  );
  const mainNameMap: Record<number, string> = {};
  const midNameMap: Record<string, string> = {};
  for (const gn of groupNames) {
    if (gn.middle_g === -1) mainNameMap[gn.main_g] = gn.name;
    else midNameMap[`${gn.main_g}/${gn.middle_g}`] = gn.name;
  }

  const enriched: EnrichedGA[] = gas.map((g) => ({
    ...g,
    main_group_name: mainNameMap[g.main_g] || '',
    middle_group_name: midNameMap[`${g.main_g}/${g.middle_g}`] || '',
    devices: gaDeviceMap[g.address] || [],
  }));
  res.json(enriched);
});

router.post('/projects/:id/gas', (req: Request, res: Response): void => {
  const b = validateBody(
    req,
    z.object({
      address: z
        .string()
        .regex(/^\d+\/\d+(\/\d+)?$/, 'Must be in X/Y/Z or X/Y format'),
      name: z.string().optional(),
      dpt: z.string().optional(),
    }),
  );
  const pid = paramId(req, 'id');
  const parts = b.address.split('/');
  const is2level = parts.length === 2;
  const [m, mi, s]: [number, number, number | null] = is2level
    ? [+parts[0]!, +parts[1]!, null]
    : parts.length === 3
      ? [+parts[0]!, +parts[1]!, +parts[2]!]
      : [0, 0, 0];
  const { lastInsertRowid } = db.run(
    'INSERT OR REPLACE INTO group_addresses (project_id,address,name,dpt,main_g,middle_g,sub_g) VALUES (?,?,?,?,?,?,?)',
    [pid, b.address, b.name || b.address, b.dpt || '', m, mi, s],
  );
  // For 2-level addresses, store middle group name
  if (is2level) {
    db.run(
      'INSERT OR REPLACE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,?,?)',
      [pid, m, mi, b.name || b.address],
    );
  }
  db.audit(
    pid,
    'create',
    'group_address',
    b.address,
    `Created group address "${b.name || b.address}"`,
  );
  db.scheduleSave();
  res.json(
    db.get('SELECT * FROM group_addresses WHERE id=?', [lastInsertRowid]),
  );
});

router.put('/projects/:pid/gas/:gid', (req: Request, res: Response): void => {
  const pid = paramId(req, 'pid');
  const gid = paramId(req, 'gid');
  const b = validateBody(
    req,
    z.object({
      name: z.string().min(1).optional(),
      dpt: z.string().optional(),
      description: z.string().optional(),
      comment: z.string().optional(),
    }),
  );
  const oldGA = db.get<GroupAddress>(
    'SELECT * FROM group_addresses WHERE id=? AND project_id=?',
    [gid, pid],
  );
  if (!oldGA) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const { track, sets, vals, diffs } = makeUpdateBuilder(oldGA);
  if (b.name !== undefined) track('name', b.name.trim());
  if (b.dpt !== undefined) track('dpt', b.dpt);
  if (b.description !== undefined) track('description', b.description);
  if (b.comment !== undefined) track('comment', b.comment);
  if (!sets.length) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }
  vals.push(gid);
  db.run(`UPDATE group_addresses SET ${sets.join(', ')} WHERE id=?`, vals);
  invalidateGaDptCache();
  db.audit(
    pid,
    'update',
    'group_address',
    (oldGA.address as string) || String(gid),
    diffs.join('; '),
  );
  db.scheduleSave();
  res.json(db.get('SELECT * FROM group_addresses WHERE id=?', [gid]));
});

// Rename a main or middle group
router.patch(
  '/projects/:pid/gas/group-name',
  (req: Request, res: Response): void => {
    const pid = paramId(req, 'pid');
    const b = validateBody(
      req,
      z.object({
        main: z.number().int().min(0).max(31),
        middle: z.number().int().min(0).max(7).nullable().optional(),
        name: z.string(),
      }),
    );
    const { main, middle, name } = b;

    const midKey = middle !== undefined && middle !== null ? middle : -1;
    const old = db.get<GaGroupName>(
      'SELECT name FROM ga_group_names WHERE project_id=? AND main_g=? AND middle_g=?',
      [pid, main, midKey],
    );
    db.run(
      'INSERT OR REPLACE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,?,?)',
      [pid, main, midKey, name],
    );
    const label = midKey === -1 ? `${main}` : `${main}/${middle}`;
    const field = midKey === -1 ? 'main_group_name' : 'middle_group_name';
    db.audit(
      pid,
      'update',
      'group_name',
      label,
      `${field}: "${(old?.name as string) ?? ''}" → "${name}"`,
    );
    db.scheduleSave();
    res.json({ ok: true });
  },
);

router.delete(
  '/projects/:pid/gas/:gid',
  (req: Request, res: Response): void => {
    const pid = paramId(req, 'pid');
    const gid = paramId(req, 'gid');
    const gaD = db.get<GroupAddress>(
      'SELECT address, name FROM group_addresses WHERE id=?',
      [gid],
    );
    db.run('DELETE FROM group_addresses WHERE id=?', [gid]);
    invalidateGaDptCache();
    db.audit(
      pid,
      'delete',
      'group_address',
      (gaD?.address as string) || String(gid),
      `Deleted group address "${(gaD?.name as string) || String(gid)}"`,
    );
    db.scheduleSave();
    res.json({ ok: true });
  },
);

// ── Com Objects ───────────────────────────────────────────────────────────────
router.get('/projects/:id/comobjects', (req: Request, res: Response): void => {
  res.json(
    db.all(
      `
    SELECT co.*, d.individual_address as device_address, d.name as device_name
    FROM com_objects co JOIN devices d ON co.device_id=d.id
    WHERE co.project_id=? ORDER BY d.area, d.line, CAST(REPLACE(d.individual_address, d.area||'.'||d.line||'.', '') AS INTEGER), co.object_number
  `,
      [paramId(req, 'id')],
    ),
  );
});

// Update GA associations on a com object
router.patch(
  '/projects/:pid/comobjects/:coid/gas',
  (req: Request, res: Response): void => {
    const pid = paramId(req, 'pid');
    const coid = paramId(req, 'coid');
    const co = db.get<ComObjectWithDevice>(
      'SELECT * FROM com_objects WHERE id=? AND project_id=?',
      [coid, pid],
    );
    if (!co) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = validateBody(
      req,
      z.object({
        add: z.string().optional(),
        remove: z.string().optional(),
        reorder: z.string().optional(),
        position: z.number().optional(),
      }),
    );
    const { add, remove, reorder, position } = b;
    let gaAddr = ((co.ga_address as string) || '').split(/\s+/).filter(Boolean);

    if (remove) {
      gaAddr = gaAddr.filter((a: string) => a !== remove);
    }
    if (add && !gaAddr.includes(add)) {
      gaAddr.push(add);
    }
    if (reorder && gaAddr.includes(reorder) && position != null) {
      gaAddr = gaAddr.filter((a: string) => a !== reorder);
      gaAddr.splice(position, 0, reorder);
    }

    // Rebuild send/receive from position: first GA = send+receive, rest = receive only
    const gaSend = gaAddr.length > 0 ? gaAddr[0]! : '';
    const gaRecv = gaAddr.join(' ');

    db.run(
      'UPDATE com_objects SET ga_address=?, ga_send=?, ga_receive=? WHERE id=?',
      [gaAddr.join(' '), gaSend, gaRecv, co.id],
    );
    const oldGAs = ((co.ga_address as string) || '').trim() || '(none)';
    const newGAs = gaAddr.join(' ') || '(none)';
    db.audit(
      pid,
      'update',
      'com_object',
      `CO ${co.object_number}`,
      `ga_address: "${oldGAs}" → "${newGAs}" on "${(co.name as string) || co.object_number}"`,
    );
    db.scheduleSave();
    res.json({
      ...co,
      ga_address: gaAddr.join(' '),
      ga_send: gaSend,
      ga_receive: gaRecv,
    });
  },
);

export { router };
