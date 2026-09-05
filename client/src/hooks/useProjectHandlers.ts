import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../api.ts';
import type { AppState, Action } from '../state.ts';
import type {
  EnrichedGA,
  Device,
  Space,
  Topology,
} from '../../../shared/types.ts';

interface UndoItem {
  desc: string;
  detail: string;
  undo: () => Promise<void>;
}

export function useProjectHandlers(
  state: AppState,
  dispatch: React.Dispatch<Action>,
) {
  // ── Undo system ─────────────────────────────────────────────────────────────
  const undoStackRef = useRef<UndoItem[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [undoOpen, setUndoOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const pushUndo = useCallback(
    (desc: string, detail: string, undoFn: () => Promise<void>) => {
      const stack = undoStackRef.current;
      stack.push({ desc, detail, undo: undoFn });
      if (stack.length > 50) stack.splice(0, stack.length - 50);
      setUndoCount(stack.length);
    },
    [],
  );

  const performUndo = useCallback(async (count: number = 1) => {
    setUndoOpen(false);
    const stack = undoStackRef.current;
    const n = Math.min(count, stack.length);
    const descs: string[] = [];
    for (let i = 0; i < n; i++) {
      const item = stack.pop();
      if (!item) break;
      try {
        await item.undo();
        descs.push(item.desc);
      } catch (e: any) {
        setToast(`Undo failed: ${e.message}`);
        break;
      }
    }
    setUndoCount(stack.length);
    if (descs.length) setToast(`Undone: ${descs.join(', ')}`);
  }, []);

  // Ctrl+Z keyboard shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        performUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [performUndo]);

  /** Extract prev values for the keys in patch, for undo. */
  const prevSnapshot = <T extends object>(
    prev: T,
    patch: Record<string, unknown>,
  ): Record<string, unknown> => {
    const rec = prev as unknown as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) result[k] = rec[k] ?? '';
    return result;
  };

  const diffDetail = <T extends object>(
    prev: T,
    patch: Record<string, unknown>,
  ): string =>
    Object.keys(patch)
      .filter(
        (k) =>
          String((prev as Record<string, unknown>)[k] ?? '') !==
          String(patch[k] ?? ''),
      )
      .map(
        (k) =>
          `${k}: "${(prev as Record<string, unknown>)[k] ?? ''}" → "${patch[k]}"`,
      )
      .join('; ');

  // ── CRUD handlers ─────────────────────────────────────────────────────────

  const handleUpdateGA = useCallback(
    async (gaId: number, patch: Record<string, unknown>) => {
      if (!state.activeProjectId) return;
      const prev = state.projectData?.gas?.find((g) => g.id === gaId);
      if (!prev) return;
      const prevPatch = prevSnapshot(prev, patch);
      const detail = diffDetail(prev, patch);
      await api.updateGA(state.activeProjectId, gaId, patch);
      dispatch({
        type: 'PATCH_GA',
        id: gaId,
        patch: patch as Partial<EnrichedGA>,
      });
      const pid = state.activeProjectId;
      pushUndo(`Edit GA ${prev.address}`, detail, async () => {
        await api.updateGA(pid, gaId, prevPatch);
        dispatch({
          type: 'PATCH_GA',
          id: gaId,
          patch: prevPatch as Partial<EnrichedGA>,
        });
      });
    },
    [state.activeProjectId, state.projectData, pushUndo],
  );

  const handleRenameGAGroup = useCallback(
    async (main: number, middle: number | null | undefined, name: string) => {
      if (!state.activeProjectId) return;
      const midVal =
        middle !== null && middle !== undefined ? middle : undefined;
      await api.renameGAGroup(state.activeProjectId, {
        main,
        middle: midVal,
        name,
      });
      // Update local state: patch all GAs in this group
      const field =
        midVal !== undefined ? 'middle_group_name' : 'main_group_name';
      dispatch({
        type: 'RENAME_GA_GROUP',
        main_g: main,
        middle_g: midVal,
        field,
        name,
      });
    },
    [state.activeProjectId],
  );

  const handleUpdateDevice = useCallback(
    async (deviceId: number, patch: Record<string, unknown>) => {
      if (!state.activeProjectId) return;
      const prev = state.projectData?.devices?.find((d) => d.id === deviceId);
      if (!prev) return;
      const prevPatch = prevSnapshot(prev, patch);
      const detail = diffDetail(prev, patch);
      // Dispatch the server's actual returned row, not the raw local
      // `patch` we sent - real bug, found live 2026-08-31: PUT
      // /devices/:id has a real server-side side effect
      // (individual_address set => has_address forced to 1, see
      // server/routes/devices.ts) the caller never explicitly asked for
      // in its own patch object. Dispatching the stale local `patch`
      // (which never mentions has_address at all) left the client's own
      // devices array believing has_address was still 0 even though the
      // DB genuinely had it as 1 - reproduced via
      // AssignProjectAddressModal: address saved correctly server-side
      // (confirmed via the DB/audit log), but the UI kept showing an
      // empty address badge and a disabled Program button.
      const updated = await api.updateDevice(
        state.activeProjectId,
        deviceId,
        patch,
      );
      dispatch({
        type: 'PATCH_DEVICE',
        id: deviceId,
        patch: updated as Partial<Device>,
      });
      const pid = state.activeProjectId;
      pushUndo(`Edit device ${prev.individual_address}`, detail, async () => {
        const reverted = await api.updateDevice(pid, deviceId, prevPatch);
        dispatch({
          type: 'PATCH_DEVICE',
          id: deviceId,
          patch: reverted as Partial<Device>,
        });
      });
    },
    [state.activeProjectId, state.projectData, pushUndo],
  );

  // Reverts a device's project address back to "unassigned" - real user
  // request, 2026-08-31, after live testing surfaced the gap: an address
  // could be assigned but there was no way back short of manually typing
  // over it. Server refuses (409) if the device already has a physically-
  // confirmed serial at that address - see the route's own doc comment.
  const handleUnassignDevice = useCallback(
    async (deviceId: number) => {
      if (!state.activeProjectId) return;
      const updated = await api.unassignDevice(state.activeProjectId, deviceId);
      dispatch({
        type: 'PATCH_DEVICE',
        id: deviceId,
        patch: updated as Partial<Device>,
      });
    },
    [state.activeProjectId],
  );

  const handleUpdateSpace = useCallback(
    async (spaceId: number, patch: Record<string, unknown>) => {
      if (!state.activeProjectId) return;
      const prev = state.projectData?.spaces?.find((s) => s.id === spaceId);
      if (!prev) return;
      const prevPatch = prevSnapshot(prev, patch);
      const detail = diffDetail(prev, patch);
      await api.updateSpace(state.activeProjectId, spaceId, patch);
      dispatch({
        type: 'PATCH_SPACE',
        id: spaceId,
        patch: patch as Partial<Space>,
      });
      const pid = state.activeProjectId;
      pushUndo(`Edit space "${prev.name}"`, detail, async () => {
        await api.updateSpace(pid, spaceId, prevPatch);
        dispatch({
          type: 'PATCH_SPACE',
          id: spaceId,
          patch: prevPatch as Partial<Space>,
        });
      });
    },
    [state.activeProjectId, state.projectData, pushUndo],
  );

  const handleCreateTopology = useCallback(
    async (body: Record<string, unknown>) => {
      if (!state.activeProjectId) return null;
      const entry = await api.createTopology(state.activeProjectId, body);
      dispatch({ type: 'ADD_TOPOLOGY', entry });
      const pid = state.activeProjectId;
      pushUndo(
        `Create ${entry.line != null ? 'line' : 'area'} ${entry.line != null ? entry.area + '.' + entry.line : entry.area}`,
        `"${entry.name || ''}"`,
        async () => {
          await api.deleteTopology(pid, entry.id);
          dispatch({ type: 'DELETE_TOPOLOGY', id: entry.id });
        },
      );
      return entry;
    },
    [state.activeProjectId, pushUndo],
  );

  const handleUpdateTopology = useCallback(
    async (topoId: number, patch: Record<string, unknown>) => {
      if (!state.activeProjectId) return;
      const prev = state.projectData?.topology?.find((t) => t.id === topoId);
      if (!prev) return;
      const prevPatch = prevSnapshot(prev, patch);
      const detail = diffDetail(prev, patch);
      await api.updateTopology(state.activeProjectId, topoId, patch);
      dispatch({
        type: 'PATCH_TOPOLOGY',
        id: topoId,
        patch: patch as Partial<Topology>,
      });
      const pid = state.activeProjectId;
      pushUndo(
        `Edit ${prev.line != null ? 'line' : 'area'} ${prev.line != null ? prev.area + '.' + prev.line : prev.area}`,
        detail,
        async () => {
          await api.updateTopology(pid, topoId, prevPatch);
          dispatch({
            type: 'PATCH_TOPOLOGY',
            id: topoId,
            patch: prevPatch as Partial<Topology>,
          });
        },
      );
    },
    [state.activeProjectId, state.projectData, pushUndo],
  );

  const handleDeleteTopology = useCallback(
    async (topoId: number) => {
      if (!state.activeProjectId) return;
      const entry = state.projectData?.topology?.find((t) => t.id === topoId);
      if (!entry) return;
      await api.deleteTopology(state.activeProjectId, topoId);
      dispatch({ type: 'DELETE_TOPOLOGY', id: topoId });
      const pid = state.activeProjectId;
      const body = {
        area: entry.area,
        line: entry.line,
        name: entry.name,
        medium: entry.medium,
      };
      pushUndo(
        `Delete ${entry.line != null ? 'line' : 'area'} ${entry.line != null ? entry.area + '.' + entry.line : entry.area}`,
        `"${entry.name || ''}"`,
        async () => {
          const restored = await api.createTopology(pid, body);
          dispatch({ type: 'ADD_TOPOLOGY', entry: restored });
        },
      );
    },
    [state.activeProjectId, state.projectData, pushUndo],
  );

  const handleCreateSpace = useCallback(
    async (body: Record<string, unknown>) => {
      if (!state.activeProjectId) return null;
      const space = await api.createSpace(state.activeProjectId, body);
      dispatch({ type: 'ADD_SPACE', space });
      const pid = state.activeProjectId;
      pushUndo(`Create space "${space.name}"`, `${space.type}`, async () => {
        await api.deleteSpace(pid, space.id);
        dispatch({
          type: 'DELETE_SPACE',
          id: space.id,
          newParentId: space.parent_id,
        });
      });
      return space;
    },
    [state.activeProjectId, pushUndo],
  );

  const handleDeleteSpace = useCallback(
    async (spaceId: number) => {
      if (!state.activeProjectId) return;
      const space = state.projectData?.spaces?.find((s) => s.id === spaceId);
      if (!space) return;
      await api.deleteSpace(state.activeProjectId, spaceId);
      dispatch({
        type: 'DELETE_SPACE',
        id: spaceId,
        newParentId: space.parent_id,
      });
      const pid = state.activeProjectId;
      const spaceData = {
        name: space.name,
        type: space.type,
        parent_id: space.parent_id,
        sort_order: space.sort_order,
      };
      pushUndo(`Delete space "${space.name}"`, `${space.type}`, async () => {
        const restored = await api.createSpace(pid, spaceData);
        dispatch({ type: 'ADD_SPACE', space: restored });
      });
    },
    [state.activeProjectId, state.projectData, pushUndo],
  );

  const handleCreateGA = useCallback(
    async (body: any) => {
      if (!state.activeProjectId) return null;
      const ga = await api.createGA(state.activeProjectId, body);
      dispatch({ type: 'ADD_GA', ga });
      const pid = state.activeProjectId;
      pushUndo(`Create GA ${ga.address}`, `"${ga.name}"`, async () => {
        await api.deleteGA(pid, ga.id);
        dispatch({ type: 'DELETE_GA', id: ga.id });
      });
      return ga;
    },
    [state.activeProjectId, pushUndo],
  );

  const handleDeleteGA = useCallback(
    async (gaId: number) => {
      if (!state.activeProjectId) return;
      const ga = state.projectData?.gas?.find((g) => g.id === gaId);
      if (!ga) return;
      await api.deleteGA(state.activeProjectId, gaId);
      dispatch({ type: 'DELETE_GA', id: gaId });
      const pid = state.activeProjectId;
      const gaData = { address: ga.address, name: ga.name, dpt: ga.dpt };
      pushUndo(`Delete GA ${ga.address}`, `"${ga.name}"`, async () => {
        const newGa = await api.createGA(pid, gaData);
        dispatch({ type: 'ADD_GA', ga: newGa });
      });
    },
    [state.activeProjectId, state.projectData, pushUndo],
  );

  const handleAddDevice = useCallback(
    async (body: any) => {
      if (!state.activeProjectId) return null;
      const device = await api.createDevice(state.activeProjectId, body);
      dispatch({ type: 'ADD_DEVICE', device });
      const pid = state.activeProjectId;
      pushUndo(
        `Add device ${device.individual_address}`,
        `"${device.name}"`,
        async () => {
          await api.deleteDevice(pid, device.id);
          dispatch({ type: 'DELETE_DEVICE', id: device.id });
        },
      );
      return device;
    },
    [state.activeProjectId, pushUndo],
  );

  // Re-runs a cached verify comparison's PROJECT/expected side against
  // fresh DB state, reusing the already-cached DEVICE/actual side - no bus
  // access. No-ops (matching the old CLEAR_VERIFY_RESULT behavior it
  // replaces) when there's no cache entry for this device to recompute
  // against - nothing stale to fix in that case. Real user feedback,
  // 2026-08-31: "If we have previously verified the device and have its
  // data in cache, why make it stale when DB items are modified? ... no
  // real gain in forcing a re-read of device memory. Better we just re-run
  // the comparison of our modified DB values against the previously cached
  // device values." Swallows its own errors (logged, not thrown) - a
  // failed recompute shouldn't surface as if the edit itself (which
  // already succeeded and was already dispatched) had failed; worst case
  // the compare view is left showing the pre-edit cached comparison, same
  // as before this feature existed.
  const refreshVerifyCache = useCallback(
    async (deviceId: number) => {
      const prior = state.verifyCache[deviceId];
      if (!prior) return;
      try {
        const result = await api.busRecomputeVerify(deviceId, prior.result);
        dispatch({ type: 'RECOMPUTE_VERIFY_RESULT', deviceId, result });
      } catch (e) {
        console.error('Failed to recompute cached verify result', e);
      }
    },
    [state.verifyCache],
  );

  const handleUpdateComObjectGAs = useCallback(
    async (coId: number, body: any) => {
      if (!state.activeProjectId) return;
      const updated = (await api.updateComObjectGAs(
        state.activeProjectId,
        coId,
        body,
      )) as {
        ga_address: string;
        ga_send: string;
        ga_receive: string;
        device_id: number;
        device_status?: string;
        last_verify_match?: null;
        last_verify_at?: null;
      };
      dispatch({
        type: 'PATCH_COMOBJECT',
        id: coId,
        patch: {
          ga_address: updated.ga_address,
          ga_send: updated.ga_send,
          ga_receive: updated.ga_receive,
        },
      });
      // Server flips devices.status 'programmed' -> 'modified' when a GA
      // link genuinely changed on an already-programmed device - see
      // markDeviceModifiedIfProgrammed() (server/routes/shared.ts). Applied
      // here as a local dispatch (not another api.setDeviceStatus round
      // trip - the server already wrote and audited it) so the
      // Programming page's badge reflects the edit immediately, not only
      // after the next Verify. Real user feedback, 2026-08-31: "If we make
      // a change, we need to indicate this somehow."
      // Extended 2026-09-01: same reasoning for the persisted verify
      // indicator - markDeviceModifiedIfProgrammed() also clears
      // last_verify_match/last_verify_at server-side when a prior verify
      // result exists; only present in the response (as `null`) when it
      // actually fired, so 'in' rather than a truthiness check.
      if ('last_verify_match' in updated) {
        dispatch({
          type: 'PATCH_DEVICE',
          id: updated.device_id,
          patch: { last_verify_match: null, last_verify_at: null },
        });
      }
      if (updated.device_status) {
        dispatch({
          type: 'SET_DEVICE_STATUS',
          deviceId: updated.device_id,
          status: updated.device_status as any,
        });
        // The Compare page (DeviceCompareResults.tsx) and the Programming
        // slide-over both read the SAME cached verify result
        // (state.verifyCache[deviceId]) - its "project" column is a
        // snapshot of what the target looked like at the moment that
        // Verify ran. Left untouched, a genuine edit silently kept showing
        // that stale pre-edit target next to the (still perfectly valid)
        // device reading. Real user feedback, 2026-08-31: "our comparison
        // page ... is still defaulting to the original unmodified
        // version" - followed by a direct correction on the fix (an
        // earlier version of this comment just cleared the cache
        // entirely): "why make it stale when DB items are modified? ...
        // Better we just re-run the comparison of our modified DB values
        // against the previously cached device values." See
        // refreshVerifyCache's own doc comment above.
        void refreshVerifyCache(updated.device_id);
      }
    },
    [state.activeProjectId, refreshVerifyCache],
  );

  const handleUpdateComObjectFlags = useCallback(
    async (coId: number, body: any) => {
      if (!state.activeProjectId) return;
      const updated = (await api.updateComObjectFlags(
        state.activeProjectId,
        coId,
        body,
      )) as {
        read: number;
        write: number;
        comm: number;
        tx: number;
        upd: number;
        read_on_init: number;
        priority: string;
        flags: string;
        device_id: number;
        device_status?: string;
        last_verify_match?: null;
        last_verify_at?: null;
      };
      dispatch({
        type: 'PATCH_COMOBJECT',
        id: coId,
        patch: {
          read: updated.read,
          write: updated.write,
          comm: updated.comm,
          tx: updated.tx,
          upd: updated.upd,
          read_on_init: updated.read_on_init,
          priority: updated.priority,
          flags: updated.flags,
        },
      });
      // See the matching comments in handleUpdateComObjectGAs above - same
      // server-side markDeviceModifiedIfProgrammed() mechanism, and same
      // local-recompute reasoning for the refreshVerifyCache call.
      if ('last_verify_match' in updated) {
        dispatch({
          type: 'PATCH_DEVICE',
          id: updated.device_id,
          patch: { last_verify_match: null, last_verify_at: null },
        });
      }
      if (updated.device_status) {
        dispatch({
          type: 'SET_DEVICE_STATUS',
          deviceId: updated.device_id,
          status: updated.device_status as any,
        });
        void refreshVerifyCache(updated.device_id);
      }
    },
    [state.activeProjectId, refreshVerifyCache],
  );

  const applyDeviceStatus = useCallback(
    (deviceId: number, status: string) => {
      dispatch({ type: 'SET_DEVICE_STATUS', deviceId, status: status as any });
      // Same local-recompute reasoning as handleUpdateComObjectGAs/Flags
      // above - every caller of applyDeviceStatus (currently just
      // DeviceParameters.tsx's save) only calls it when the server
      // actually persisted a genuine change, so the device's cached
      // verify result (its "project" column) is stale the moment this
      // fires.
      void refreshVerifyCache(deviceId);
    },
    [refreshVerifyCache],
  );

  // Local-only store update (no API call), added 2026-09-01 alongside the
  // persisted verify indicator - same reasoning as applyDeviceStatus
  // above: DeviceParameters.tsx's param-value save already gets
  // last_verify_match/last_verify_at back from the server (see
  // markDeviceModifiedIfProgrammed(), server/routes/shared.ts) when a
  // prior verify result existed and this edit invalidated it - this just
  // reflects that into the client's own devices array immediately,
  // without a redundant extra round trip.
  const applyDeviceVerifyCleared = useCallback((deviceId: number) => {
    dispatch({
      type: 'PATCH_DEVICE',
      id: deviceId,
      patch: { last_verify_match: null, last_verify_at: null },
    });
  }, []);

  // The other side of applyDeviceVerifyCleared above - records a REAL
  // verify outcome (server already persisted this in the same
  // /bus/verify-device call, see runVerifyDevice()'s own doc comment,
  // server/routes/bus.ts). Local-only, same reasoning as applyDeviceStatus
  // - the timestamp is computed here rather than round-tripped from the
  // server response, which is fine for display purposes (the two are at
  // most a network round trip apart) without adding a new response field
  // just for this.
  const applyDeviceVerifyResult = useCallback(
    (deviceId: number, match: boolean) => {
      dispatch({
        type: 'PATCH_DEVICE',
        id: deviceId,
        patch: {
          last_verify_match: match ? 1 : 0,
          last_verify_at: new Date().toISOString(),
        },
      });
    },
    [],
  );

  const handleAddScannedDevice = useCallback(
    async (address: string) => {
      // Real request, 2026-08-31 (AddressDeviceModal's "add as if it were
      // a new unassigned device"): the caller needs the created row back
      // to chain a serial-number record onto it - throwing here (instead
      // of the previous silent no-op return) surfaces a genuinely missing
      // project id as a real error rather than a call that quietly does
      // nothing.
      if (!state.activeProjectId) throw new Error('No active project');
      const [a, l] = address.split('.').map(Number);
      const device = await api.createDevice(state.activeProjectId, {
        individual_address: address,
        name: address,
        area: a,
        line: l,
        device_type: 'generic',
      });
      dispatch({ type: 'ADD_DEVICE', device });
      return device;
    },
    [state.activeProjectId],
  );

  return {
    // Undo system
    undoStackRef,
    undoCount,
    undoOpen,
    setUndoOpen,
    performUndo,
    toast,
    setToast,
    // CRUD handlers
    handleUpdateGA,
    handleRenameGAGroup,
    handleUpdateDevice,
    handleUnassignDevice,
    handleUpdateSpace,
    handleCreateTopology,
    handleUpdateTopology,
    handleDeleteTopology,
    handleCreateSpace,
    handleDeleteSpace,
    handleCreateGA,
    handleDeleteGA,
    handleAddDevice,
    handleUpdateComObjectGAs,
    handleUpdateComObjectFlags,
    handleAddScannedDevice,
    applyDeviceStatus,
    applyDeviceVerifyCleared,
    applyDeviceVerifyResult,
  };
}
