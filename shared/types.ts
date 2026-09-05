// Core entity types shared between server and client.
// These mirror the SQLite schema defined in server/db.ts.
//
// SQLite has no native boolean type — boolean columns are stored as 0 | 1.
// We use `SqliteBool` to make the intent clear while matching the runtime type.
export type SqliteBool = 0 | 1;

export type DeviceType = 'actuator' | 'sensor' | 'router' | 'generic';
export type DeviceStatus =
  | 'programmed'
  | 'modified'
  | 'unassigned'
  | 'deleted'
  | 'error';
export type ComObjectDirection = 'input' | 'output' | 'both';
export type SpaceType =
  | 'Building'
  | 'Floor'
  | 'Stairway'
  | 'Corridor'
  | 'Room'
  | 'DistributionBoard'
  | 'Undefined';
export type Medium = 'TP' | 'RF' | 'IP' | 'PL';

export interface Project {
  id: number;
  name: string;
  file_name: string | null;
  created_at: string;
  updated_at: string;
  thumbnail: string;
  project_info: string;
}

export interface Device {
  id: number;
  project_id: number;
  individual_address: string;
  name: string;
  description: string;
  comment: string;
  order_number: string;
  serial_number: string;
  manufacturer: string;
  model: string;
  product_ref: string;
  area: number;
  line: number;
  area_name: string;
  line_name: string;
  medium: Medium;
  device_type: DeviceType;
  status: DeviceStatus;
  last_modified: string;
  last_download: string;
  app_number: string;
  app_version: string;
  app_ref: string;
  parameters: string;
  param_values: string;
  space_id: number | null;
  model_translations: string;
  bus_current: number;
  width_mm: number;
  is_power_supply: SqliteBool;
  is_coupler: SqliteBool;
  is_rail_mounted: SqliteBool;
  installation_hints: string;
  floor_x: number;
  floor_y: number;
  // Whether this device carries a real individual address from the project
  // file. A DeviceInstance can be imported with no Address attribute at all
  // (dropped into the topology but not yet placed on a line) - such a
  // device gets a synthetic, non-colliding individual_address (see
  // ets-parser.ts) purely so it has a stable DB key and is visible in the
  // UI; it is not a real, writable KNX address. 0 for these; 1 otherwise.
  has_address: SqliteBool;
  // Real request, 2026-08-31: the project's own cached `LastUsedAPDULength`
  // (off the real `<DeviceInstance>` XML) - what ETS itself last used for
  // this device's real memory-write chunk size, confirmed to exactly match
  // a live `PID_MAX_APDULENGTH` (property 56) read for one real device.
  // Empty string when this device has never been downloaded to from this
  // project (no cached value yet) - see
  // `KnxConnection._resolveMaxApduLength()`'s own doc comment
  // (knx-connection.ts) for how this is used as a preferred, no-bus-
  // round-trip source ahead of the live property read.
  apdu_length: string;
  // Count/detail of writes whose response never arrived during this
  // device's last download (server/knx-connection.ts's DownloadResult) -
  // 0/'[]' means every write was confirmed. Drives the "verify
  // recommended" indicator; cleared on the next download or a successful
  // verify. unconfirmed_writes_detail is a JSON-encoded string[].
  unconfirmed_writes_count: number;
  unconfirmed_writes_detail: string;
  // Persisted last-verify outcome, added 2026-09-01 - real request: "we
  // should consider an indicator for both successful verify and failed".
  // null = never verified (distinct from a real failed verify, hence
  // nullable rather than a plain boolean) - see server/db.ts's own
  // migration comment for the full write/clear trail (written by a real
  // live bus verify only; cleared on the next download, on unassign, and
  // on any edit made after a verify recorded a result).
  last_verify_match: number | null;
  last_verify_at: string | null;
}

export interface GroupAddress {
  id: number;
  project_id: number;
  address: string;
  name: string;
  dpt: string;
  main_g: number;
  middle_g: number;
  sub_g: number;
  comment: string;
  description: string;
}

export interface ComObject {
  id: number;
  project_id: number;
  device_id: number;
  object_number: number;
  channel: string;
  name: string;
  function_text: string;
  dpt: string;
  object_size: string;
  flags: string;
  direction: ComObjectDirection;
  ga_address: string;
  ga_send: string;
  ga_receive: string;
  // Added 2026-08-29 for Object 3 (Group Object Table) support - see
  // ets-app.ts's CoDef/CorDef and docs/knx-device-write-protocol.md §10.1.
  // read_on_init/read/write/comm/tx are stored as SQLite's
  // boolean-as-INTEGER convention (0/1). read/write/comm/tx are the raw
  // booleans `flags` (a composite display string, lossy in its all-false
  // fallback case) was never safe to parse back into.
  read_on_init: number;
  priority: string;
  read: number;
  write: number;
  comm: number;
  tx: number;
  // `upd`, not `update` - UPDATE is a SQL keyword, so the DB column (and
  // this field) is named `upd` to avoid any risk of an unquoted identifier
  // collision in raw SQL elsewhere against this table. Added 2026-08-29
  // fixing a real bug: Update was never given its own raw column when
  // read/write/comm/tx were, and was separately being resolved wrong
  // (read directly off the ComObjectRef with no fallback to the base
  // ComObject's declared value) - see ets-app.ts's CoDef.update comment.
  upd: number;
}

export interface ComObjectWithDevice extends ComObject {
  device_address: string;
  device_name: string;
}

export interface Space {
  id: number;
  project_id: number;
  name: string;
  type: SpaceType;
  parent_id: number | null;
  sort_order: number;
  usage_id: string;
}

export interface Topology {
  id: number;
  project_id: number;
  area: number;
  line: number | null;
  name: string;
  medium: Medium;
}

export interface BusTelegram {
  id: number;
  project_id: number | null;
  timestamp: string;
  src: string | null;
  dst: string | null;
  type: string | null;
  raw_value: string | null;
  decoded: string | null;
  priority: string;
}

export interface Setting {
  key: string;
  value: string;
}

export interface CatalogSection {
  id: string;
  project_id: number;
  name: string;
  number: string;
  parent_id: string | null;
  mfr_id: string;
  manufacturer: string;
}

export interface CatalogItem {
  id: string;
  project_id: number;
  name: string;
  number: string;
  description: string;
  section_id: string;
  product_ref: string;
  h2p_ref: string;
  order_number: string;
  manufacturer: string;
  mfr_id: string;
  model: string;
  bus_current: number;
  width_mm: number;
  is_power_supply: SqliteBool;
  is_coupler: SqliteBool;
  is_rail_mounted: SqliteBool;
}

export interface AuditLogEntry {
  id: number;
  project_id: number;
  timestamp: string;
  action: string;
  entity: string;
  entity_id: string;
  detail: string;
}

export interface GaGroupName {
  project_id: number;
  main_g: number;
  middle_g: number;
  name: string;
}

// Maps built from com_objects linking devices to group addresses
export interface GAMaps {
  deviceGAMap: Record<string, string[]>;
  gaDeviceMap: Record<string, string[]>;
}

// GA with group names and device list attached (returned by getProjectFull)
export interface EnrichedGA extends GroupAddress {
  main_group_name: string;
  middle_group_name: string;
  devices: string[];
}

// Full project data bundle returned by getProjectFull
export interface ProjectFull {
  project: Project;
  devices: Device[];
  gas: EnrichedGA[];
  comObjects: ComObjectWithDevice[];
  deviceGAMap: Record<string, string[]>;
  gaDeviceMap: Record<string, string[]>;
  spaces: Space[];
  topology: Topology[];
}

// Result of db.run()
export interface RunResult {
  lastInsertRowid: number | null;
  changes: number;
}

// DPT info entry from parsed KNX master XML
export interface DptInfoEntry {
  name: string;
  text: string;
  unit: string;
  sizeInBit: number;
  coefficient?: number;
  enums?: Record<number, string>;
}

// Telegram as seen on the bus (before/after remapping)
export interface Telegram {
  projectId?: number | string;
  src: string;
  dst: string;
  type: string;
  raw_value: string;
  decoded?: string;
  priority?: string;
}
