import {
  useState,
  useRef,
  useEffect,
  useContext,
  useMemo,
  useCallback,
} from 'react';
import { useC } from '../theme.ts';
import { PinContext } from '../contexts.ts';
import { DeviceTypeIcon } from '../icons.jsx';
import { Btn, Empty } from '../primitives.jsx';
import { api } from '../api.ts';

const COLMAP = {
  actuator: '#4fc3f7',
  sensor: '#aed581',
  router: '#ffb74d',
  generic: '#999',
};

import { AddDeviceModal } from '../AddDeviceModal.jsx';

export function FloorPlanView({
  data,
  activeProjectId,
  onUpdateDevice,
  jumpTo,
  onAddDevice,
}) {
  const C = useC();
  const pin = useContext(PinContext);
  const { spaces = [], devices = [] } = data || {};

  // Build space tree to find floors and their descendant devices
  const { floors, floorDevices } = useMemo(() => {
    const nodeMap = {};
    for (const s of spaces) nodeMap[s.id] = { ...s, children: [] };
    const roots = [];
    for (const s of spaces) {
      if (s.parent_id && nodeMap[s.parent_id])
        nodeMap[s.parent_id].children.push(nodeMap[s.id]);
      else roots.push(nodeMap[s.id]);
    }
    const floors = [];
    const collectFloors = (nodes) => {
      for (const n of nodes) {
        if (n.type === 'Floor' || n.type === 'BuildingPart') floors.push(n);
        else collectFloors(n.children);
      }
    };
    collectFloors(roots);
    const locSort = localStorage.getItem('knx-loc-sort') || 'import';
    floors.sort((a, b) =>
      locSort === 'name'
        ? a.name.localeCompare(b.name)
        : (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
          a.name.localeCompare(b.name),
    );

    const floorDevices = {};
    for (const floor of floors) {
      const spaceIds = new Set();
      const walk = (node) => {
        spaceIds.add(node.id);
        node.children.forEach(walk);
      };
      walk(floor);
      floorDevices[floor.id] = devices.filter(
        (d) => d.space_id && spaceIds.has(d.space_id),
      );
    }
    return { floors, floorDevices };
  }, [spaces, devices]);

  const [activeFloor, setActiveFloor] = useState(null);
  useEffect(() => {
    if (
      floors.length > 0 &&
      (!activeFloor || !floors.find((f) => f.id === activeFloor))
    ) {
      setActiveFloor(floors[0].id);
    }
  }, [floors]);

  // Jump to a specific floor when navigated from another view
  useEffect(() => {
    if (jumpTo?.spaceId && floors.find((f) => f.id === jumpTo.spaceId)) {
      setActiveFloor(jumpTo.spaceId);
    }
  }, [jumpTo?.ts]);

  if (!spaces.length)
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <Empty icon="◻" msg="No location data in this project" />
      </div>
    );

  if (!floors.length)
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <Empty icon="◻" msg="No floors found in the location hierarchy" />
      </div>
    );

  const floor = floors.find((f) => f.id === activeFloor);
  const devs = floorDevices[activeFloor] || [];

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          borderBottom: `1px solid ${C.border}`,
          flexShrink: 0,
          overflow: 'auto',
        }}
      >
        {floors.map((f) => (
          <div
            key={f.id}
            onClick={() => setActiveFloor(f.id)}
            style={{
              padding: '8px 16px',
              fontSize: 11,
              cursor: 'pointer',
              borderBottom:
                f.id === activeFloor
                  ? `2px solid ${C.accent}`
                  : '2px solid transparent',
              color: f.id === activeFloor ? C.text : C.muted,
              fontWeight: f.id === activeFloor ? 600 : 400,
              whiteSpace: 'nowrap',
            }}
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
          C={C}
        />
      )}
    </div>
  );
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
  C,
}) {
  const [imgUrl, setImgUrl] = useState(null);
  const [dragging, setDragging] = useState(null); // deviceId being dragged
  const [dragPos, setDragPos] = useState(null); // { x, y } in 0..1 fractions
  const [showAdd, setShowAdd] = useState(false);
  const dragOffsetRef = useRef(null); // { dx, dy } offset from cursor to device center in fractions
  const [_imgSize, setImgSize] = useState(null); // { w, h } of rendered image
  const imgRef = useRef(null);
  const fileRef = useRef(null);

  // Cancel CSS zoom on the canvas area so mouse coordinates work correctly
  const appZoom =
    parseFloat(document.getElementById('root')?.firstChild?.style?.zoom) || 1;

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

  const handleUpload = async (e) => {
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
    const m = {};
    for (const s of spaces) m[s.id] = s.name;
    return m;
  }, [spaces]);

  // Group devices by room (for unplaced sidebar)
  const devicesByRoom = useMemo(() => {
    const m = {};
    for (const d of devices) {
      const room = roomMap[d.space_id] || 'Unassigned';
      if (!m[room]) m[room] = [];
      m[room].push(d);
    }
    return m;
  }, [devices, roomMap]);

  const placed = devices.filter((d) => d.floor_x >= 0 && d.floor_y >= 0);
  const unplaced = devices.filter((d) => d.floor_x < 0 || d.floor_y < 0);
  const wrapRef = useRef(null);

  // Convert React event clientX/Y to 0..1 fraction relative to the image wrapper.
  // IMPORTANT: only use with React synthetic events — they are in the same coordinate
  // space as getBoundingClientRect when inside a CSS-zoomed container. Native window
  // events use a different coordinate space and CANNOT be mixed with getBoundingClientRect.
  const getFrac = useCallback((clientX, clientY) => {
    const el = wrapRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (clientY - r.top) / r.height)),
    };
  }, []);

  const startDrag = (e, deviceId) => {
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

  // Handle drag move/end via a full-screen React overlay (rendered below),
  // NOT via window.addEventListener. This keeps all events in the React/zoomed
  // coordinate space, avoiding the CSS zoom coordinate mismatch.
  const onDragOverlayMove = useCallback(
    (e) => {
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
    (e) => {
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
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 11, color: C.muted }}>
          No floor plan image for {floor.name}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={handleUpload}
          style={{ display: 'none' }}
        />
        <Btn onClick={() => fileRef.current?.click()}>Upload floor plan</Btn>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      {/* Main canvas area — inverse zoom cancels app root zoom so mouse coords work */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          position: 'relative',
          background: C.bg,
          zoom: 1 / appZoom,
        }}
      >
        <div
          ref={wrapRef}
          style={{ position: 'relative', display: 'inline-block' }}
        >
          <img
            ref={imgRef}
            src={imgUrl}
            alt={floor.name}
            onLoad={onImgLoad}
            style={{
              display: 'block',
              maxWidth: '100%',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
            draggable={false}
          />
          {/* Full-screen drag overlay */}
          {dragging != null && (
            <div
              onMouseMove={onDragOverlayMove}
              onMouseUp={onDragOverlayUp}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 9999,
                cursor: 'grabbing',
              }}
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
                style={{
                  position: 'absolute',
                  left: `${x * 100}%`,
                  top: `${y * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  cursor: isDragging ? 'grabbing' : 'grab',
                  zIndex: isDragging ? 100 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  background: isDragging ? `${C.accent}40` : `${C.bg}cc`,
                  border: `1px solid ${COLMAP[d.device_type] || C.muted}`,
                  borderRadius: 4 * appZoom,
                  padding: `${2 * appZoom}px ${6 * appZoom}px`,
                  fontSize: 9 * appZoom,
                  color: C.text,
                  whiteSpace: 'nowrap',
                  userSelect: 'none',
                }}
              >
                <DeviceTypeIcon
                  type={d.device_type}
                  size={10 * appZoom}
                  style={{ color: COLMAP[d.device_type] || C.muted }}
                />
                <span
                  style={{
                    maxWidth: 80 * appZoom,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {d.name}
                </span>
                <span
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onUpdateDevice(d.id, { floor_x: -1, floor_y: -1 });
                  }}
                  title="Remove from floor plan"
                  style={{
                    marginLeft: 2,
                    cursor: 'pointer',
                    color: C.dim,
                    fontSize: 8 * appZoom,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </span>
              </div>
            );
          })}
        </div>
        {/* Controls — inside the canvas scroll area, zoom reset so they render at normal size */}
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            display: 'flex',
            gap: 6,
            zIndex: 300,
            zoom: appZoom,
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={handleUpload}
            style={{ display: 'none' }}
          />
          {onAddDevice && (
            <Btn
              onClick={() => setShowAdd(true)}
              style={{ fontSize: 9, padding: '3px 8px' }}
              color={C.green}
            >
              + Add Device
            </Btn>
          )}
          <Btn
            onClick={() => fileRef.current?.click()}
            style={{ fontSize: 9, padding: '3px 8px' }}
          >
            Replace image
          </Btn>
          <Btn
            onClick={handleDelete}
            style={{ fontSize: 9, padding: '3px 8px' }}
          >
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
        <div
          style={{
            width: 180,
            borderLeft: `1px solid ${C.border}`,
            overflow: 'auto',
            flexShrink: 0,
            padding: 8,
          }}
        >
          <div
            style={{
              fontSize: 9,
              color: C.dim,
              letterSpacing: '0.08em',
              marginBottom: 8,
            }}
          >
            UNPLACED ({unplaced.length})
          </div>
          {Object.entries(devicesByRoom).map(([room, roomDevs]) => {
            const unplacedInRoom = roomDevs.filter(
              (d) => d.floor_x < 0 || d.floor_y < 0,
            );
            if (!unplacedInRoom.length) return null;
            return (
              <div key={room} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 9, color: C.muted, marginBottom: 4 }}>
                  {room}
                </div>
                {unplacedInRoom.map((d) => (
                  <div
                    key={d.id}
                    onMouseDown={(e) => startDrag(e, d.id)}
                    title={d.individual_address}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '3px 6px',
                      marginBottom: 2,
                      borderRadius: 3,
                      background: C.surface,
                      border: `1px solid ${C.border}`,
                      fontSize: 9,
                      color: C.text,
                      cursor: 'grab',
                      userSelect: 'none',
                    }}
                  >
                    <DeviceTypeIcon
                      type={d.device_type}
                      size={10}
                      style={{ color: COLMAP[d.device_type] || C.muted }}
                    />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {d.name}
                    </span>
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
