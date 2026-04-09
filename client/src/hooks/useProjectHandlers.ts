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
      await api.updateDevice(state.activeProjectId, deviceId, patch);
      dispatch({
        type: 'PATCH_DEVICE',
        id: deviceId,
        patch: patch as Partial<Device>,
      });
      const pid = state.activeProjectId;
      pushUndo(`Edit device ${prev.individual_address}`, detail, async () => {
        await api.updateDevice(pid, deviceId, prevPatch);
        dispatch({
          type: 'PATCH_DEVICE',
          id: deviceId,
          patch: prevPatch as Partial<Device>,
        });
      });
    },
    [state.activeProjectId, state.projectData, pushUndo],
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

  const handleUpdateComObjectGAs = useCallback(
    async (coId: number, body: any) => {
      if (!state.activeProjectId) return;
      const updated = (await api.updateComObjectGAs(
        state.activeProjectId,
        coId,
        body,
      )) as { ga_address: string; ga_send: string; ga_receive: string };
      dispatch({
        type: 'PATCH_COMOBJECT',
        id: coId,
        patch: {
          ga_address: updated.ga_address,
          ga_send: updated.ga_send,
          ga_receive: updated.ga_receive,
        },
      });
    },
    [state.activeProjectId],
  );

  const handleAddScannedDevice = useCallback(
    async (address: string) => {
      if (!state.activeProjectId) return;
      const [a, l] = address.split('.').map(Number);
      const device = await api.createDevice(state.activeProjectId, {
        individual_address: address,
        name: address,
        area: a,
        line: l,
        device_type: 'generic',
      });
      dispatch({ type: 'ADD_DEVICE', device });
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
    handleAddScannedDevice,
  };
}
