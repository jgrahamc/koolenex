/**
 * Application-program parsing for "module architecture" apps, where one
 * <ModuleDef> is instantiated several times from the application's Dynamic
 * section and each instance is parameterised by <NumericArg> values:
 *
 *  - <Module> instantiations nested deep inside Channel/choose/when (and
 *    inside another ModuleDef's own Dynamic) must be found, with their args.
 *  - A parameter's <Memory BaseOffset="..."> (own, or inherited from the
 *    enclosing <Union>) and <Parameter BaseValue="..."> are captured as
 *    Argument-id references, and the Argument id -> name map is exposed.
 *  - A comm object's BaseNumber makes its object number instance-relative.
 *    Object 3 (the group object table) is keyed by those absolute numbers:
 *    module-scoped objects reached without instance args are skipped, and
 *    genuinely active instances are recursed into.
 *  - TypeFloat sizes follow the declared Encoding.
 *  - Static table capacity and the extended-memory-services option are read.
 *
 * Fixtures are small anonymous ETS-shaped XML documents built inline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAppIndex } from '../server/ets-app.ts';
import {
  buildGroupObjectTable,
  computeGroupObjectByte,
} from '../server/routes/knx-tables.ts';
import { rawMinizipCtor } from '../server/minizip.ts';
import { parseKnxproj } from '../server/ets-parser.ts';

const APP = 'M-0001_A-T1';
const MD1 = `${APP}_MD-1`;

interface AppParts {
  appAttrs?: string;
  typesXml?: string;
  staticXml?: string;
  moduleDefs?: string;
  dynamic?: string;
}

function appXml(p: AppParts = {}): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer Id="M-0001">
      <ApplicationPrograms>
        <ApplicationProgram Id="${APP}" ${p.appAttrs ?? ''}>
          <Static>
            <ParameterTypes>
              <ParameterType Id="${APP}_PT-1"><TypeNumber SizeInBit="8" /></ParameterType>
              ${p.typesXml ?? ''}
            </ParameterTypes>
            ${p.staticXml ?? ''}
          </Static>
          ${p.moduleDefs ? `<ModuleDefs>${p.moduleDefs}</ModuleDefs>` : ''}
          <Dynamic>${p.dynamic ?? ''}</Dynamic>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;
}

function index(xml: string) {
  const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
  assert.ok(idx, 'buildAppIndex should parse the synthetic app XML');
  return idx!;
}

const MD_ARGS = `<Arguments>
  <Argument Id="${MD1}_A-1" Name="Base" />
  <Argument Id="${MD1}_A-2" Name="Num" />
  <Argument Id="${MD1}_A-3" Name="Mode" />
</Arguments>`;

// ─── Module instantiations ───────────────────────────────────────────────────

describe('module architecture: ordered <Module> collection', () => {
  const xml = appXml({
    moduleDefs: `
      <ModuleDef Id="${MD1}" Name="One">
        ${MD_ARGS}
        <Static />
      </ModuleDef>
      <ModuleDef Id="${APP}_MD-2" Name="Two">
        <Static />
        <Dynamic>
          <Channel Id="${APP}_CH-2" Name="Nested">
            <Module Id="${MD1}_M-8" RefId="${MD1}">
              <NumericArg RefId="${MD1}_A-1" Value="500" />
            </Module>
          </Channel>
        </Dynamic>
      </ModuleDef>`,
    dynamic: `
      <Channel Id="${APP}_CH-1" Name="Channel">
        <choose ParamRefId="${APP}_P-9_R-9">
          <when test="0">
            <Module Id="${MD1}_M-1" RefId="${MD1}">
              <NumericArg RefId="${MD1}_A-1" Value="340" />
              <NumericArg RefId="${MD1}_A-2" Value="100" />
              <NumericArg RefId="${MD1}_A-99" Value="5" />
            </Module>
          </when>
          <when default="true">
            <Module Id="${MD1}_M-2" RefId="${MD1}" Count="3">
              <NumericArg RefId="${MD1}_A-1" Value="360" />
            </Module>
          </when>
        </choose>
      </Channel>`,
  });

  it('finds modules nested in Channel/choose/when and resolves their NumericArgs by name', () => {
    const idx = index(xml);
    assert.deepEqual(idx.getModArgs(`${MD1}_M-1`), {
      Base: '340',
      Num: '100',
      _count: 1,
    });
    assert.deepEqual(idx.getModArgs(`${MD1}_M-2`), { Base: '360', _count: 3 });
  });

  it('ignores a NumericArg whose RefId is not a declared Argument', () => {
    const args = index(xml).getModArgs(`${MD1}_M-1`)!;
    assert.deepEqual(Object.keys(args).sort(), ['Base', 'Num', '_count']);
  });

  it("finds a module instantiated inside another ModuleDef's own Dynamic", () => {
    const idx = index(xml);
    assert.deepEqual(idx.getModArgs(`${MD1}_M-8`), { Base: '500', _count: 1 });
    assert.deepEqual(idx.moduleKeys.slice().sort(), [
      `${MD1}_M-1`,
      `${MD1}_M-2`,
      `${MD1}_M-8`,
    ]);
  });

  it('returns null for a module that is not instantiated anywhere', () => {
    assert.equal(index(xml).getModArgs(`${MD1}_M-77`), null);
  });
});

// ─── BaseOffset / BaseValue / Union defaults ─────────────────────────────────

describe('module architecture: BaseOffset, BaseValue and Union markers', () => {
  const model = index(
    appXml({
      moduleDefs: `
        <ModuleDef Id="${MD1}" Name="One">
          ${MD_ARGS}
          <Static>
            <Parameters>
              <Parameter Id="${MD1}_P-1" ParameterType="${APP}_PT-1" Text="Standalone" Value="7">
                <Memory Offset="2" BitOffset="0" BaseOffset="${MD1}_A-1" />
              </Parameter>
              <Parameter Id="${MD1}_P-2" ParameterType="${APP}_PT-1" Text="Plain" Value="1">
                <Memory Offset="9" BitOffset="0" />
              </Parameter>
              <Union SizeInBit="8">
                <Memory Offset="4" BitOffset="0" BaseOffset="${MD1}_A-1" />
                <Parameter Id="${MD1}_UP-3" ParameterType="${APP}_PT-1" Text="First" Value="1" Offset="0" BitOffset="0" DefaultUnionParameter="0" />
                <Parameter Id="${MD1}_UP-4" ParameterType="${APP}_PT-1" Text="Second" Value="2" Offset="0" BitOffset="0">
                  <Memory BaseOffset="${MD1}_A-2" />
                </Parameter>
                <Parameter Id="${MD1}_UP-5" ParameterType="${APP}_PT-1" Text="Third" Value="3" Offset="0" BitOffset="0" />
              </Union>
              <Parameter Id="${MD1}_P-6" ParameterType="${APP}_PT-1" Text="Selector" Value="0" Access="None" BaseValue="${MD1}_A-3" />
              <Parameter Id="${MD1}_P-7" ParameterType="${APP}_PT-1" Text="Other selector" Value="0" Access="None" />
            </Parameters>
            <ParameterRefs>
              <ParameterRef Id="${MD1}_P-1_R-1" RefId="${MD1}_P-1" />
              <ParameterRef Id="${MD1}_P-2_R-2" RefId="${MD1}_P-2" />
              <ParameterRef Id="${MD1}_UP-3_R-3" RefId="${MD1}_UP-3" />
              <ParameterRef Id="${MD1}_UP-4_R-4" RefId="${MD1}_UP-4" />
              <ParameterRef Id="${MD1}_UP-5_R-5" RefId="${MD1}_UP-5" />
              <ParameterRef Id="${MD1}_P-6_R-6" RefId="${MD1}_P-6" />
              <ParameterRef Id="${MD1}_P-7_R-7" RefId="${MD1}_P-7" />
            </ParameterRefs>
          </Static>
        </ModuleDef>`,
      dynamic: `<Module Id="${MD1}_M-1" RefId="${MD1}"><NumericArg RefId="${MD1}_A-1" Value="340" /></Module>`,
    }),
  ).buildParamModel();
  const layout = model.paramMemLayout;

  it("captures a parameter's own <Memory BaseOffset> as an Argument id, keeping the relative offset", () => {
    const e = layout[`${MD1}_P-1_R-1`]!;
    assert.equal(e.baseOffsetArgId, `${MD1}_A-1`);
    assert.equal(
      e.offset,
      2,
      'the offset stays module-relative; expansion adds the base later',
    );
  });

  it('gives a parameter with no BaseOffset no baseOffsetArgId at all', () => {
    const e = layout[`${MD1}_P-2_R-2`]!;
    assert.equal(e.offset, 9);
    assert.ok(!('baseOffsetArgId' in e));
  });

  it("inherits the enclosing Union's BaseOffset for its members, an own BaseOffset taking priority", () => {
    assert.equal(layout[`${MD1}_UP-3_R-3`]!.baseOffsetArgId, `${MD1}_A-1`);
    assert.equal(layout[`${MD1}_UP-5_R-5`]!.baseOffsetArgId, `${MD1}_A-1`);
    assert.equal(layout[`${MD1}_UP-4_R-4`]!.baseOffsetArgId, `${MD1}_A-2`);
    // Union members share the Union's own byte offset.
    for (const k of ['UP-3_R-3', 'UP-4_R-4', 'UP-5_R-5']) {
      assert.equal(layout[`${MD1}_${k}`]!.offset, 4);
      assert.equal(layout[`${MD1}_${k}`]!.fromMemoryChild, true);
    }
  });

  it('marks only the DefaultUnionParameter="0" member as the Union default', () => {
    assert.equal(layout[`${MD1}_UP-3_R-3`]!.isDefaultUnionParam, true);
    assert.ok(!('isDefaultUnionParam' in layout[`${MD1}_UP-4_R-4`]!));
    assert.ok(!('isDefaultUnionParam' in layout[`${MD1}_UP-5_R-5`]!));
  });

  it('exposes the Argument id -> name map', () => {
    assert.deepEqual(model.argDefs, {
      [`${MD1}_A-1`]: 'Base',
      [`${MD1}_A-2`]: 'Num',
      [`${MD1}_A-3`]: 'Mode',
    });
  });

  it('collects BaseValue per Parameter id, only for parameters that declare one', () => {
    assert.deepEqual(model.baseValueArgIds, { [`${MD1}_P-6`]: `${MD1}_A-3` });
  });

  it("exposes the module instances' resolved args on the model", () => {
    assert.deepEqual(model.modArgs[`${MD1}_M-1`], { Base: '340', _count: 1 });
  });
});

// ─── ParameterRef Value vs Parameter Value ───────────────────────────────────

describe('paramMemLayout keeps the Parameter default and the ParameterRef value apart', () => {
  const model = index(
    appXml({
      staticXml: `
        <Parameters>
          <Parameter Id="${APP}_P-1" ParameterType="${APP}_PT-1" Text="A" Value="5"><Memory Offset="0" BitOffset="0" /></Parameter>
          <Parameter Id="${APP}_P-2" ParameterType="${APP}_PT-1" Text="B" Value="6"><Memory Offset="1" BitOffset="0" /></Parameter>
        </Parameters>
        <ParameterRefs>
          <ParameterRef Id="${APP}_P-1_R-1" RefId="${APP}_P-1" Value="9" />
          <ParameterRef Id="${APP}_P-2_R-2" RefId="${APP}_P-2" />
        </ParameterRefs>`,
    }),
  ).buildParamModel();

  it("defaultValue is always the Parameter's own value", () => {
    assert.equal(model.paramMemLayout[`${APP}_P-1_R-1`]!.defaultValue, '5');
    assert.equal(model.paramMemLayout[`${APP}_P-2_R-2`]!.defaultValue, '6');
  });

  it("refValue carries the ParameterRef's value only when the ref declares one", () => {
    assert.equal(model.paramMemLayout[`${APP}_P-1_R-1`]!.refValue, '9');
    assert.ok(!('refValue' in model.paramMemLayout[`${APP}_P-2_R-2`]!));
  });
});

// ─── TypeFloat sizes ─────────────────────────────────────────────────────────

describe('TypeFloat size follows the declared Encoding', () => {
  function floatEntry(typeAttrs: string) {
    return index(
      appXml({
        typesXml: `<ParameterType Id="${APP}_PT-F"><TypeFloat ${typeAttrs} /></ParameterType>`,
        staticXml: `
          <Parameters>
            <Parameter Id="${APP}_P-1" ParameterType="${APP}_PT-F" Text="F" Value="0.2"><Memory Offset="0" BitOffset="0" /></Parameter>
          </Parameters>
          <ParameterRefs><ParameterRef Id="${APP}_P-1_R-1" RefId="${APP}_P-1" /></ParameterRefs>`,
      }),
    ).buildParamModel().paramMemLayout[`${APP}_P-1_R-1`]!;
  }

  it('IEEE-754 Single is a 4-byte float', () => {
    const e = floatEntry('Encoding="IEEE-754 Single"');
    assert.equal(e.bitSize, 32);
    assert.equal(e.isFloat, true);
  });

  it('IEEE-754 Double is an 8-byte float', () => {
    assert.equal(floatEntry('Encoding="IEEE-754 Double"').bitSize, 64);
  });

  it('DPT 9, an unrecognised encoding and no encoding are the 2-byte KNX float', () => {
    assert.equal(floatEntry('Encoding="DPT 9"').bitSize, 16);
    assert.equal(floatEntry('Encoding="Something Else"').bitSize, 16);
    assert.equal(floatEntry('minInclusive="0"').bitSize, 16);
  });

  it("an explicit SizeInBit overrides the encoding's default", () => {
    assert.equal(
      floatEntry('Encoding="IEEE-754 Single" SizeInBit="16"').bitSize,
      16,
    );
    assert.equal(floatEntry('SizeInBit="32"').bitSize, 32);
  });
});

// ─── Static options and table capacity ───────────────────────────────────────

describe('application-level static declarations', () => {
  it('reads AddressTable/AssociationTable MaxEntries as numbers', () => {
    const idx = index(
      appXml({
        staticXml:
          '<AddressTable MaxEntries="1024" /><AssociationTable MaxEntries="2048" />',
      }),
    );
    assert.equal(idx.gaTableMaxEntries, 1024);
    assert.equal(idx.assocTableMaxEntries, 2048);
  });

  it('reads each capacity independently', () => {
    const idx = index(
      appXml({ staticXml: '<AssociationTable MaxEntries="300" />' }),
    );
    assert.ok(Number.isNaN(idx.gaTableMaxEntries));
    assert.equal(idx.assocTableMaxEntries, 300);
  });

  it('reports NaN, not 0, for an absent element or a non-numeric MaxEntries', () => {
    const none = index(appXml());
    assert.ok(Number.isNaN(none.gaTableMaxEntries));
    assert.ok(Number.isNaN(none.assocTableMaxEntries));
    const bad = index(
      appXml({
        staticXml:
          '<AddressTable MaxEntries="many" /><AssociationTable MaxEntries="" />',
      }),
    );
    assert.ok(Number.isNaN(bad.gaTableMaxEntries));
    assert.ok(Number.isNaN(bad.assocTableMaxEntries));
  });

  it('reads SupportsExtendedMemoryServices from the <Options> element', () => {
    const on = index(
      appXml({
        staticXml: '<Options SupportsExtendedMemoryServices="true" />',
      }),
    );
    assert.equal(on.supportsExtendedMemoryServices, true);
    const off = index(
      appXml({
        staticXml: '<Options SupportsExtendedMemoryServices="false" />',
      }),
    );
    assert.equal(off.supportsExtendedMemoryServices, false);
    assert.equal(
      index(appXml({ staticXml: '<Options />' }))
        .supportsExtendedMemoryServices,
      false,
    );
    assert.equal(index(appXml()).supportsExtendedMemoryServices, false);
  });

  it('does not confuse the option with the IsSecureEnabled application attribute', () => {
    const secure = index(appXml({ appAttrs: 'IsSecureEnabled="true"' }));
    assert.equal(secure.isSecureEnabled, true);
    assert.equal(secure.supportsExtendedMemoryServices, false);
  });
});

// ─── Communication object numbering and Object 3 ─────────────────────────────

const CO_FLAGS =
  'ObjectSize="1 Bit" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" DatapointType="DPST-1-1"';

/**
 * ModuleDef 1 owns four comm objects: 3 and 4 are instance-relative
 * (BaseNumber), 5 and 6 are absolute. Its own Dynamic references object 3,
 * 5, an object 4 that only exists while the module's selector parameter is
 * 1, and an object 6 gated by a plain application-level selector.
 */
function objectsApp(): string {
  return appXml({
    staticXml: `
      <Parameters>
        <Parameter Id="${APP}_P-9" ParameterType="${APP}_PT-1" Text="Global" Value="0"><Memory Offset="0" BitOffset="0" /></Parameter>
      </Parameters>
      <ParameterRefs><ParameterRef Id="${APP}_P-9_R-9" RefId="${APP}_P-9" /></ParameterRefs>`,
    moduleDefs: `
      <ModuleDef Id="${MD1}" Name="One">
        ${MD_ARGS}
        <Static>
          <Parameters>
            <Parameter Id="${MD1}_P-2" ParameterType="${APP}_PT-1" Text="Sel" Value="0"><Memory Offset="1" BitOffset="0" /></Parameter>
          </Parameters>
          <ParameterRefs><ParameterRef Id="${MD1}_P-2_R-2" RefId="${MD1}_P-2" /></ParameterRefs>
          <ComObjects>
            <ComObject Id="${MD1}_O-3" Number="3" BaseNumber="${MD1}_A-2" Text="Three" ${CO_FLAGS} />
            <ComObject Id="${MD1}_O-4" Number="4" BaseNumber="${MD1}_A-2" Text="Four" ${CO_FLAGS} />
            <ComObject Id="${MD1}_O-5" Number="5" Text="Five" ${CO_FLAGS} />
            <ComObject Id="${MD1}_O-6" Number="6" Text="Six" ${CO_FLAGS} />
          </ComObjects>
          <ComObjectRefs>
            <ComObjectRef Id="${MD1}_O-3_R-3" RefId="${MD1}_O-3" />
            <ComObjectRef Id="${MD1}_O-4_R-4" RefId="${MD1}_O-4" />
            <ComObjectRef Id="${MD1}_O-5_R-5" RefId="${MD1}_O-5" />
            <ComObjectRef Id="${MD1}_O-6_R-6" RefId="${MD1}_O-6" />
          </ComObjectRefs>
        </Static>
        <Dynamic>
          <ParameterRefRef RefId="${MD1}_P-2_R-2" />
          <ComObjectRefRef RefId="${MD1}_O-3_R-3" />
          <ComObjectRefRef RefId="${MD1}_O-5_R-5" />
          <choose ParamRefId="${MD1}_P-2_R-2">
            <when test="1"><ComObjectRefRef RefId="${MD1}_O-4_R-4" /></when>
          </choose>
          <choose ParamRefId="${APP}_P-9_R-9">
            <when test="1"><ComObjectRefRef RefId="${MD1}_O-6_R-6" /></when>
          </choose>
        </Dynamic>
      </ModuleDef>`,
    dynamic: `
      <ParameterBlock Id="${APP}_PB-1" Name="pb" Text="pb"><ParameterRefRef RefId="${APP}_P-9_R-9" /></ParameterBlock>
      <Channel Id="${APP}_CH-1" Name="Channel">
        <Module Id="${MD1}_M-1" RefId="${MD1}"><NumericArg RefId="${MD1}_A-2" Value="100" /></Module>
        <Module Id="${MD1}_M-2" RefId="${MD1}"><NumericArg RefId="${MD1}_A-2" Value="200" /></Module>
      </Channel>`,
  });
}

function evalWith(values: Record<string, string>) {
  const idx = index(objectsApp());
  const calls: string[] = [];
  const res = idx.evalDynamic((k) => {
    calls.push(k);
    return values[k] ?? null;
  });
  return { idx, calls, ...res };
}

describe('BaseNumber: instance-relative communication object numbers', () => {
  const idx = index(objectsApp());

  it("resolveCoRef adds the instance's BaseNumber argument to the template Number", () => {
    assert.equal(
      idx.resolveCoRef('MD-1_M-1_MI-1_O-3_R-3', '')!.objectNumber,
      103,
    );
    assert.equal(
      idx.resolveCoRef('MD-1_M-2_MI-1_O-3_R-3', '')!.objectNumber,
      203,
    );
  });

  it('leaves an object without BaseNumber at its own Number for every instance', () => {
    assert.equal(
      idx.resolveCoRef('MD-1_M-1_MI-1_O-5_R-5', '')!.objectNumber,
      5,
    );
    assert.equal(
      idx.resolveCoRef('MD-1_M-2_MI-1_O-5_R-5', '')!.objectNumber,
      5,
    );
  });

  it('resolveCoRefById, given no instance context, reports the bare template Number', () => {
    assert.equal(idx.resolveCoRefById(`${MD1}_O-3_R-3`)!.objectNumber, 3);
  });

  it('falls back to the bare Number when the instance does not carry the argument', () => {
    const noArg = index(
      appXml({
        moduleDefs: `
          <ModuleDef Id="${MD1}" Name="One">
            ${MD_ARGS}
            <Static>
              <ComObjects><ComObject Id="${MD1}_O-3" Number="3" BaseNumber="${MD1}_A-2" Text="T" ${CO_FLAGS} /></ComObjects>
              <ComObjectRefs><ComObjectRef Id="${MD1}_O-3_R-3" RefId="${MD1}_O-3" /></ComObjectRefs>
            </Static>
          </ModuleDef>`,
        dynamic: `<Module Id="${MD1}_M-1" RefId="${MD1}"><NumericArg RefId="${MD1}_A-1" Value="5" /></Module>`,
      }),
    );
    assert.equal(
      noArg.resolveCoRef('MD-1_M-1_MI-1_O-3_R-3', '')!.objectNumber,
      3,
    );
  });
});

describe('evalDynamic: active communication objects keyed by absolute number', () => {
  it("recurses into every instantiated module with that instance's own args", () => {
    const { activeCorefsByObjNum } = evalWith({});
    assert.ok(activeCorefsByObjNum.has(103));
    assert.ok(activeCorefsByObjNum.has(203));
    assert.deepEqual(
      activeCorefsByObjNum.get(103)!.map((e) => e.corId),
      [`${MD1}_O-3_R-3`],
    );
  });

  it('skips a BaseNumber object reached with no instance args, so no template-number ghost appears', () => {
    const { activeCorefsByObjNum } = evalWith({});
    assert.ok(!activeCorefsByObjNum.has(3), 'object 3 exists only as 103/203');
    assert.ok(!activeCorefsByObjNum.has(4));
  });

  it('keeps an absolute (non-BaseNumber) object reached both from the template and from each instance', () => {
    const { activeCorefsByObjNum } = evalWith({});
    assert.ok(activeCorefsByObjNum.has(5));
  });

  it("gates a module's own choose per instance, using the instance-qualified selector key", () => {
    const { activeCorefsByObjNum, calls } = evalWith({
      [`${MD1}_M-2_MI-1_P-2_R-2`]: '1',
    });
    assert.ok(calls.includes(`${MD1}_M-1_MI-1_P-2_R-2`));
    assert.ok(calls.includes(`${MD1}_M-2_MI-1_P-2_R-2`));
    assert.ok(activeCorefsByObjNum.has(204), 'instance 2 selected the branch');
    assert.ok(!activeCorefsByObjNum.has(104), 'instance 1 did not');
  });

  it('looks a selector that belongs to the application, not the module, up unqualified', () => {
    const { activeCorefsByObjNum, calls } = evalWith({
      [`${APP}_P-9_R-9`]: '1',
    });
    assert.ok(calls.includes(`${APP}_P-9_R-9`));
    assert.ok(!calls.some((k) => /_M-\d+_MI-\d+_P-9_R-9$/.test(k)));
    assert.ok(activeCorefsByObjNum.has(6));
  });

  it('builds a group object table with the two instances at distinct offsets and no ghost at the template number', () => {
    const { idx } = evalWith({});
    const flagsOf = (rel: string, objectNumber: number) => {
      const r = idx.resolveCoRef(rel, '')!;
      return {
        object_number: objectNumber,
        write: r.write,
        communication: r.comm,
        transmit: r.tx,
        read: r.read,
        update: r.update,
        linked: true,
      };
    };
    const rows = [
      flagsOf('MD-1_M-1_MI-1_O-3_R-3', 103),
      flagsOf('MD-1_M-2_MI-1_O-3_R-3', 203),
    ];
    const table = buildGroupObjectTable(2 * 210 + 2, rows);
    assert.equal(table.readUInt16BE(0), 210, 'header holds the table capacity');
    const expected = computeGroupObjectByte(rows[0]!);
    assert.notEqual(expected, 0);
    assert.equal(table[103 * 2], expected);
    assert.equal(table[203 * 2], expected);
    assert.equal(table[3 * 2], 0, 'no entry at the bare template number');
  });
});

// ─── Whole project: object numbers and options reach the parsed output ──────

interface MinizipWriteInstance {
  append(path: string, data: Buffer): void;
  zip(): Uint8Array;
}
const Minizip = rawMinizipCtor as new () => MinizipWriteInstance;

const XMLNS = 'http://knx.org/xml/project/23';

function projectZip(appXmlText: string, deviceExtra = ''): Buffer {
  const mz = new Minizip();
  mz.append(`M-0001/${APP}.xml`, Buffer.from(appXmlText, 'utf8'));
  mz.append(
    'P-0001/project.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="${XMLNS}"><Project Id="P-0001"><ProjectInformation Name="T" GroupAddressStyle="ThreeLevel" Guid="00000000-0000-0000-0000-000000000000" /></Project></KNX>`,
      'utf8',
    ),
  );
  mz.append(
    'P-0001/0.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="${XMLNS}">
  <Project Id="P-0001">
    <Installations>
      <Installation Name="T">
        <Topology>
          <Area Address="1" Name="A">
            <Line Address="1" Name="L">
              <DeviceInstance Id="DI-1" Address="5" Name="Dev" Hardware2ProgramRefId="M-0001_H-X_HP-T1">
                ${deviceExtra}
              </DeviceInstance>
            </Line>
          </Area>
        </Topology>
      </Installation>
    </Installations>
  </Project>
</KNX>`,
      'utf8',
    ),
  );
  return Buffer.from(mz.zip());
}

describe('parseKnxproj: module-architecture application programs', () => {
  it('reports each active module object under its absolute number, from every instance', () => {
    const parsed = parseKnxproj(projectZip(objectsApp()), null);
    const nums = parsed.comObjects
      .map((c) => c.object_number)
      .sort((a, b) => a - b);
    // 103/203 come from the module recursion; 5 is absolute. Without BaseNumber
    // resolution both instances would collapse onto number 3.
    assert.deepEqual(nums, [5, 103, 203]);
    assert.ok(parsed.comObjects.every((c) => c.device_address === '1.1.5'));
  });

  it('honours a per-instance parameter value when deciding which module objects exist', () => {
    const parsed = parseKnxproj(
      projectZip(
        objectsApp(),
        `<ParameterInstanceRefs>
           <ParameterInstanceRef RefId="${MD1}_M-2_MI-1_P-2_R-2" Value="1" />
         </ParameterInstanceRefs>`,
      ),
      null,
    );
    const nums = parsed.comObjects
      .map((c) => c.object_number)
      .sort((a, b) => a - b);
    assert.deepEqual(nums, [5, 103, 203, 204]);
  });

  it('stores the static capacities and the extended-memory option on the app model', () => {
    const xml = appXml({
      staticXml:
        '<Options SupportsExtendedMemoryServices="true" /><AddressTable MaxEntries="512" /><AssociationTable MaxEntries="1024" />',
    });
    const model = parseKnxproj(projectZip(xml), null).paramModels[APP]!;
    assert.equal(model.supportsExtendedMemoryServices, true);
    assert.equal(model.gaTableMaxEntries, 512);
    assert.equal(model.assocTableMaxEntries, 1024);
  });

  it('leaves the capacities off the model when the app declares none or a non-numeric one', () => {
    const none = parseKnxproj(projectZip(appXml()), null).paramModels[APP]!;
    assert.ok(!('gaTableMaxEntries' in none));
    assert.ok(!('assocTableMaxEntries' in none));
    assert.equal(none.supportsExtendedMemoryServices, false);
    const bad = parseKnxproj(
      projectZip(
        appXml({
          staticXml:
            '<AddressTable MaxEntries="n/a" /><AssociationTable MaxEntries="64" />',
        }),
      ),
      null,
    ).paramModels[APP]!;
    assert.ok(!('gaTableMaxEntries' in bad));
    assert.equal(bad.assocTableMaxEntries, 64);
  });
});
