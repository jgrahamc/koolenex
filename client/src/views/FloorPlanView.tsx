import {
  useState,
  useRef,
  useEffect,
  useContext,
  useMemo,
  useCallback,
} from 'react';
import { useLocation } from 'react-router-dom';
import { PinContext } from '../contexts.ts';
import { DeviceTypeIcon } from '../icons.tsx';
import { Btn, Empty } from '../primitives.tsx';
import { api } from '../api.ts';

const COLMAP: Record<string, string> = {
  actuator: '#4fc3f7',
  sensor: '#aed581',
  router: '#ffb74d',
  generic: '#999',
};

import { AddDeviceModal } from '../AddDeviceModal.tsx';
import styles from './FloorPlanView.module.css';

import type { ProjectFull } from '../../../shared/types.ts';

interface FloorPlanViewProps {
  data: ProjectFull | null;
  activeProjectId: number | null;
  onUpdateDevice?:
    | ((id: number, updates: Record<string, unknown>) => void)
    | null;
  onAddDevice?: ((body: Record<string, unknown>) => Promise<unknown>) | null;
}

export function FloorPlanView({
  data,
  activeProjectId,
  onUpdateDevice,
  onAddDevice,
}: FloorPlanViewProps) {
  const location = useLocation();
  const locState = location.state as { jumpTo?: number } | null;
  const jumpTo =
    locState?.jumpTo != null
      ? { spaceId: locState.jumpTo as any, ts: Date.now() }
      : undefined;
  const pin = useContext(PinContext);
  const { spaces = [], devices = [] } = data || {};

  // Build space tree to find floors and their descendant devices
  const { floors, floorDevices } = useMemo(() => {
    const nodeMap: Record<string, any> = {};
    for (const s of spaces) nodeMap[s.id] = { ...s, children: [] };
    const roots: any[] = [];
    for (const s of spaces) {
      if (s.parent_id && nodeMap[s.parent_id])
        nodeMap[s.parent_id].children.push(nodeMap[s.id]);
      else roots.push(nodeMap[s.id]);
    }
    const floors: any[] = [];
    const collectFloors = (nodes: any[]) => {
      for (const n of nodes) {
        if (n.type === 'Floor' || n.type === 'BuildingPart') floors.push(n);
        else collectFloors(n.children);
      }
    };
    collectFloors(roots);
    const locSort = localStorage.getItem('knx-loc-sort') || 'import';
    floors.sort((a: any, b: any) =>
      locSort === 'name'
        ? a.name.localeCompare(b.name)
        : (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
          a.name.localeCompare(b.name),
    );

    const floorDevices: Record<string, any[]> = {};
    for (const floor of floors) {
      const spaceIds = new Set<string>();
      const walk = (node: any) => {
        spaceIds.add(node.id);
        node.children.forEach(walk);
      };
      walk(floor);
      floorDevices[floor.id] = devices.filter(
        (d: any) => d.space_id && spaceIds.has(d.space_id),
      );
    }
    return { floors, floorDevices };
  }, [spaces, devices]);

  const [activeFloor, setActiveFloor] = useState<string | null>(null);
  useEffect(() => {
    if (
      floors.length > 0 &&
      (!activeFloor || !floors.find((f: any) => f.id === activeFloor))
    ) {
      setActiveFloor(floors[0].id);
    }
  }, [floors]);

  // Jump to a specific floor when navigated from another view
  useEffect(() => {
    if (jumpTo?.spaceId && floors.find((f: any) => f.id === jumpTo.spaceId)) {
      setActiveFloor(jumpTo.spaceId);
    }
  }, [jumpTo?.ts]);

  if (!spaces.length)
    return (
      <div className={styles.emptyWrap}>
        <Empty icon="◻" msg="No location data in this project" />
      </div>
    );

  if (!floors.length)
    return (
      <div className={styles.emptyWrap}>
        <Empty icon="◻" msg="No floors found in the location hierarchy" />
      </div>
    );

  const floor = floors.find((f: any) => f.id === activeFloor);
  const devs = floorDevices[activeFloor!] || [];

  return (
    <div className={styles.root}>
      {/* Tab bar */}
      <div className={styles.tabBar}>
        {floors.map((f: any) => (
          <div
            key={f.id}
            onClick={() => setActiveFloor(f.id)}
            className={f.id === activeFloor ? styles.tabActive : styles.tab}
          >
            {f.name}
          </div>
        ))}
      </div>

      {floor && (
        <FloorPlanCanvas
          key={floor.id}
          floor={floor}
          devices={devs}
          spaces={spaces}
          projectId={activeProjectId}
          onUpdateDevice={onUpdateDevice}
          onAddDevice={onAddDevice}
          data={data}
          pin={pin}
        />
      )}
    </div>
  );
}

interface FloorPlanCanvasProps {
  floor: any;
  devices: any[];
  spaces: any[];
  projectId: any;
  onUpdateDevice?: ((id: any, updates: any) => void) | null;
  onAddDevice?: ((body: any) => Promise<any>) | null;
  data: any;
  pin: any;
}

function FloorPlanCanvas({
  floor,
  devices,
  spaces,
  projectId,
  onUpdateDevice,
  onAddDevice,
  data,
  pin: _pin,
}: FloorPlanCanvasProps) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState<any>(null); // deviceId being dragged
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null); // { x, y } in 0..1 fractions
  const [showAdd, setShowAdd] = useState(false);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null); // { dx, dy } offset from cursor to device center in fractions
  const [_imgSize, setImgSize] = useState<{ w: number; h: number } | null>(
    null,
  ); // { w, h } of rendered image
  const imgRef = useRef<HTMLImageElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Cancel CSS zoom on the canvas area so mouse coordinates work correctly
  const appZoom =
    parseFloat(
      (document.getElementById('root')?.firstChild as HTMLElement)?.style?.zoom,
    ) || 1;

  // Load floor plan image
  useEffect(() => {
    const url = api.getFloorPlanUrl(projectId, floor.id);
    fetch(url)
      .then((r) => {
        if (r.ok) setImgUrl(url + '?t=' + Date.now());
        else setImgUrl(null);
      })
      .catch(() => setImgUrl(null));
  }, [projectId, floor.id]);

  // Track image rendered size
  const onImgLoad = () => {
    const img = imgRef.current;
    if (img) setImgSize({ w: img.clientWidth, h: img.clientHeight });
  };
  useEffect(() => {
    const obs = new ResizeObserver(() => {
      const img = imgRef.current;
      if (img) setImgSize({ w: img.clientWidth, h: img.clientHeight });
    });
    if (imgRef.current) obs.observe(imgRef.current);
    return () => obs.disconnect();
  }, [imgUrl]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    await api.uploadFloorPlan(projectId, floor.id, fd);
    setImgUrl(api.getFloorPlanUrl(projectId, floor.id) + '?t=' + Date.now());
    e.target.value = '';
  };

  const handleDelete = async () => {
    await api.deleteFloorPlan(projectId, floor.id);
    setImgUrl(null);
  };

  // Room map
  const roomMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of spaces) m[s.id] = s.name;
    return m;
  }, [spaces]);

  // Group devices by room (for unplaced sidebar)
  const devicesByRoom = useMemo(() => {
    const m: Record<string, any[]> = {};
    for (const d of devices) {
      const room = roomMap[d.space_id] || 'Unassigned';
      if (!m[room]) m[room] = [];
      m[room]!.push(d);
    }
    return m;
  }, [devices, roomMap]);

  const placed = devices.filter((d) => d.floor_x >= 0 && d.floor_y >= 0);
  const unplaced = devices.filter((d) => d.floor_x < 0 || d.floor_y < 0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Convert React event clientX/Y to 0..1 fraction relative to the image wrapper.
  const getFrac = useCallback((clientX: number, clientY: number) => {
    const el = wrapRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (clientY - r.top) / r.height)),
    };
  }, []);

  const startDrag = (e: React.MouseEvent, deviceId: any) => {
    e.preventDefault();
    e.stopPropagation();
    const dev = devices.find((d) => d.id === deviceId);
    const clickPos = getFrac(e.clientX, e.clientY);
    // Record offset between cursor and device center so the device doesn't jump on grab
    if (dev && dev.floor_x >= 0 && clickPos) {
      dragOffsetRef.current = {
        dx: dev.floor_x - clickPos.x,
        dy: dev.floor_y - clickPos.y,
      };
    } else {
      dragOffsetRef.current = { dx: 0, dy: 0 };
    }
    setDragging(deviceId);
    // Keep device at its current position until the mouse moves
    if (dev && dev.floor_x >= 0) {
      setDragPos({ x: dev.floor_x, y: dev.floor_y });
    } else if (clickPos) {
      setDragPos(clickPos);
    }
  };

  // Handle drag move/end via a full-screen React overlay
  const onDragOverlayMove = useCallback(
    (e: React.MouseEvent) => {
      const pos = getFrac(e.clientX, e.clientY);
      if (!pos) return;
      const off = dragOffsetRef.current || { dx: 0, dy: 0 };
      setDragPos({
        x: Math.max(0, Math.min(1, pos.x + off.dx)),
        y: Math.max(0, Math.min(1, pos.y + off.dy)),
      });
    },
    [getFrac],
  );

  const onDragOverlayUp = useCallback(
    (e: React.MouseEvent) => {
      const pos = getFrac(e.clientX, e.clientY);
      const off = dragOffsetRef.current || { dx: 0, dy: 0 };
      if (pos && onUpdateDevice && dragging != null) {
        const fx = Math.max(0, Math.min(1, pos.x + off.dx));
        const fy = Math.max(0, Math.min(1, pos.y + off.dy));
        onUpdateDevice(dragging, { floor_x: fx, floor_y: fy });
      }
      setDragging(null);
      setDragPos(null);
    },
    [getFrac, onUpdateDevice, dragging],
  );

  if (!imgUrl) {
    return (
      <div className={styles.noImgWrap}>
        <div className={styles.noImgText}>
          No floor plan image for {floor.name}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={handleUpload}
          className={styles.hidden}
        />
        <Btn onClick={() => fileRef.current?.click()}>Upload floor plan</Btn>
      </div>
    );
  }

  return (
    <div className={styles.canvasWrap}>
      {/* Main canvas area */}
      <div className={styles.canvasArea} style={{ zoom: 1 / appZoom }}>
        <div ref={wrapRef} className={styles.imgWrap}>
          <img
            ref={imgRef}
            src={imgUrl}
            alt={floor.name}
            onLoad={onImgLoad}
            className={styles.floorImg}
            draggable={false}
          />
          {/* Full-screen drag overlay */}
          {dragging != null && (
            <div
              onMouseMove={onDragOverlayMove}
              onMouseUp={onDragOverlayUp}
              className={styles.dragOverlay}
            />
          )}
          {/* Placed devices */}
          {placed.map((d) => {
            const isDragging = dragging === d.id;
            const x = isDragging && dragPos ? dragPos.x : d.floor_x;
            const y = isDragging && dragPos ? dragPos.y : d.floor_y;
            return (
              <div
                key={d.id}
                onMouseDown={(e) => startDrag(e, d.id)}
                title={`${d.individual_address} — ${d.name}\n${roomMap[d.space_id] || ''}`}
                className={styles.placedDev}
                style={{
                  left: `${x * 100}%`,
                  top: `${y * 100}%`,
                  cursor: isDragging ? 'grabbing' : 'grab',
                  zIndex: isDragging ? 100 : 1,
                  background: isDragging ? 'var(--accent-40)' : 'var(--bg-cc)',
                  border: `1px solid ${COLMAP[d.device_type] || 'var(--muted)'}`,
                  borderRadius: 4 * appZoom,
                  padding: `${2 * appZoom}px ${6 * appZoom}px`,
                  fontSize: 9 * appZoom,
                }}
              >
                <DeviceTypeIcon
                  type={d.device_type}
                  size={10 * appZoom}
                  style={{ color: COLMAP[d.device_type] || 'var(--muted)' }}
                />
                <span
                  className={styles.devNameClip}
                  style={{ maxWidth: 80 * appZoom }}
                >
                  {d.name}
                </span>
                <span
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onUpdateDevice?.(d.id, { floor_x: -1, floor_y: -1 });
                  }}
                  title="Remove from floor plan"
                  className={styles.removePin}
                  style={{ fontSize: 8 * appZoom }}
                >
                  ✕
                </span>
              </div>
            );
          })}
        </div>
        {/* Controls */}
        <div className={styles.controls} style={{ zoom: appZoom }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={handleUpload}
            className={styles.hidden}
          />
          {onAddDevice && (
            <Btn
              onClick={() => setShowAdd(true)}
              className={styles.btnSmall}
              color="var(--green)"
            >
              + Add Device
            </Btn>
          )}
          <Btn
            onClick={() => fileRef.current?.click()}
            className={styles.btnSmall}
          >
            Replace image
          </Btn>
          <Btn onClick={handleDelete} className={styles.btnSmall}>
            Remove
          </Btn>
        </div>
      </div>
      {showAdd && onAddDevice && (
        <AddDeviceModal
          data={data}
          defaults={{ space_id: floor.id }}
          onAdd={onAddDevice}
          onClose={() => setShowAdd(false)}
        />
      )}

      {/* Unplaced devices sidebar */}
      {unplaced.length > 0 && (
        <div className={styles.unplacedSidebar}>
          <div className={styles.unplacedLabel}>
            UNPLACED ({unplaced.length})
          </div>
          {Object.entries(devicesByRoom).map(([room, roomDevs]) => {
            const unplacedInRoom = roomDevs.filter(
              (d: any) => d.floor_x < 0 || d.floor_y < 0,
            );
            if (!unplacedInRoom.length) return null;
            return (
              <div key={room} className={styles.roomGroup}>
                <div className={styles.roomName}>{room}</div>
                {unplacedInRoom.map((d: any) => (
                  <div
                    key={d.id}
                    onMouseDown={(e) => startDrag(e, d.id)}
                    title={d.individual_address}
                    className={styles.unplacedDev}
                  >
                    <DeviceTypeIcon
                      type={d.device_type}
                      size={10}
                      style={{ color: COLMAP[d.device_type] || 'var(--muted)' }}
                    />
                    <span className={styles.devNameClip}>{d.name}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
