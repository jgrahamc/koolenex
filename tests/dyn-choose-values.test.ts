/**
 * A <choose> controlled by a parameter with no device memory.
 *
 * An ETS Parameter's memory allocation is optional. In one real
 * application program (M-0004_A-5017-51-218F) 1201 of 3367 Parameters
 * carry no Offset at all - TypeRestriction, TypeNumber, TypeText,
 * TypePicture - and 257 of its 851 <choose> elements are controlled by
 * one of them. They are design-time selectors: they decide which other
 * parameters are shown and which memory is written, so the device never
 * needs to be told which branch was chosen. A <Union> is exactly that
 * arrangement - one byte holding one of several alternatives, picked by a
 * selector that occupies nothing itself.
 *
 * Such a parameter still has a value: Parameter@Value, overridable by
 * ParameterRef@Value and by the project. koolenex's two exported maps are
 * each filtered for their own purpose - `params` for the editor (drops
 * Access="None", TypeNone and unlabelled refs), `paramMemLayout` for the
 * download image (drops anything with no offset) - so a parameter that is
 * both memory-less and hidden fell out of both. Its value then read as
 * the empty string, matched no <when test>, and the whole branch went to
 * `default`, selecting the wrong member of a Union.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evalConditionallyActiveParamRefs,
  type DynTree,
} from '../server/routes/knx-tables.ts';

/**
 * One <choose> on `SEL`, with a real branch for value "1" and a default.
 * `A` is the member that should be live when SEL=1; `B` the default one.
 */
const SEL = 'APP_P-1_R-1';
const dynTree = {
  main: {
    items: [
      {
        type: 'choose',
        paramRefId: SEL,
        accessNone: false,
        defaultValue: null,
        whens: [
          {
            test: '1',
            isDefault: false,
            items: [{ type: 'paramRef', refId: 'APP_UP-A_R-A' }],
          },
          {
            isDefault: true,
            items: [{ type: 'paramRef', refId: 'APP_UP-B_R-B' }],
          },
        ],
      },
    ],
  },
  moduleDefs: [],
} as unknown as DynTree;

describe('evalConditionallyActiveParamRefs with a memory-less controller', () => {
  it('takes the default branch when the controller cannot be resolved', () => {
    // The behaviour before paramRefValues existed, and the behaviour a
    // model cached before it still gets: SEL is in neither map, so its
    // value is "", no test matches, and `default` wins.
    const active = evalConditionallyActiveParamRefs(dynTree, {}, {});
    assert.ok(!active.has('APP_UP-A_R-A'));
    assert.ok(active.has('APP_UP-B_R-B'));
  });

  it('takes the declared branch when paramRefValues supplies the value', () => {
    const active = evalConditionallyActiveParamRefs(
      dynTree,
      {},
      {},
      {
        [SEL]: '1',
      },
    );
    assert.ok(
      active.has('APP_UP-A_R-A'),
      'the branch the product data actually declares',
    );
    assert.ok(!active.has('APP_UP-B_R-B'));
  });

  it('still lets the project override the declared value', () => {
    // A value stored in the project beats the declaration, exactly as it
    // does for a parameter that does have memory.
    const active = evalConditionallyActiveParamRefs(
      dynTree,
      {},
      { [SEL]: '7' },
      { [SEL]: '1' },
    );
    assert.ok(!active.has('APP_UP-A_R-A'));
    assert.ok(active.has('APP_UP-B_R-B'), 'no test matches 7, so default');
  });

  it('prefers a resolvable params entry, leaving existing models unchanged', () => {
    // paramRefValues carries the same declared value for refs that ARE in
    // `params`, so it must not change what those resolve to.
    const active = evalConditionallyActiveParamRefs(
      dynTree,
      { [SEL]: { defaultValue: '1' } } as never,
      {},
      { [SEL]: '1' },
    );
    assert.ok(active.has('APP_UP-A_R-A'));
  });
});
