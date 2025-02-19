export const description = `
Test GPUAdapter.requestDevice.

Note tests explicitly destroy created devices so that tests don't have to wait for GC to clean up
potentially limited native resources.
`;

import { Fixture } from '../../../../common/framework/fixture.js';
import { makeTestGroup } from '../../../../common/framework/test_group.js';
import { getGPU } from '../../../../common/util/navigator_gpu.js';
import { assert, raceWithRejectOnTimeout } from '../../../../common/util/util.js';
import { kFeatureNames, kLimitInfo, kLimits } from '../../../capability_info.js';
import { clamp, isPowerOfTwo } from '../../../util/math.js';

export const g = makeTestGroup(Fixture);

g.test('default')
  .desc(
    `
    Test requesting the device with a variation of default parameters.
    - No features listed in default device
    - Default limits`
  )
  .paramsSubcasesOnly(u =>
    u.combine('args', [
      [],
      [undefined],
      [{}],
      [{ requiredFeatures: [], requiredLimits: {} }],
    ] as const)
  )
  .fn(async t => {
    const { args } = t.params;
    const gpu = getGPU();
    const adapter = await gpu.requestAdapter();
    assert(adapter !== null);
    const device = await adapter.requestDevice(...args);
    assert(device !== null);

    // Default device should have no features.
    t.expect(device.features.size === 0, 'Default device should not have any features');
    // All limits should be defaults.
    for (const limit of kLimits) {
      t.expect(
        device.limits[limit] === kLimitInfo[limit].default,
        `Expected ${limit} == default: ${device.limits[limit]} != ${kLimitInfo[limit].default}`
      );
    }

    device.destroy();
  });

g.test('invalid')
  .desc(
    `
    Test that requesting device on an invalid adapter resolves with lost device.
    - Induce invalid adapter via a device lost from a device.destroy()`
  )
  .fn(async t => {
    const gpu = getGPU();
    const adapter = await gpu.requestAdapter();
    assert(adapter !== null);

    {
      // Request a device and destroy it immediately afterwards.
      const device = await adapter.requestDevice();
      assert(device !== null);
      device.destroy();
      const lostInfo = await device.lost;
      t.expect(lostInfo.reason === 'destroyed');
    }

    // The adapter should now be invalid since a device was lost. Requesting another device should
    // return an already lost device.
    const kTimeoutMS = 1000;
    const device = await adapter.requestDevice();
    const lost = await raceWithRejectOnTimeout(device.lost, kTimeoutMS, 'device was not lost');
    t.expect(lost.reason === undefined);
  });

g.test('features,unknown')
  .desc(
    `
    Test requesting device with an unknown feature.`
  )
  .fn(async t => {
    const gpu = getGPU();
    const adapter = await gpu.requestAdapter();
    assert(adapter !== null);

    t.shouldReject(
      'TypeError',
      adapter.requestDevice({ requiredFeatures: ['unknown-feature' as GPUFeatureName] })
    );
  });

g.test('features,known')
  .desc(
    `
    Test requesting device with all features.
    - Succeeds with device supporting feature if adapter supports the feature.
    - Rejects if the adapter does not support the feature.`
  )
  .params(u => u.combine('feature', kFeatureNames))
  .fn(async t => {
    const { feature } = t.params;

    const gpu = getGPU();
    const adapter = await gpu.requestAdapter();
    assert(adapter !== null);

    const promise = adapter.requestDevice({ requiredFeatures: [feature] });
    if (adapter.features.has(feature)) {
      const device = await promise;
      t.expect(device.features.has(feature), 'Device should include the required feature');
    } else {
      t.shouldReject('TypeError', promise);
    }
  });

g.test('limits,unknown')
  .desc(
    `
    Test that specifying limits that aren't part of the supported limit set causes
    requestDevice to reject.`
  )
  .fn(async t => {
    const gpu = getGPU();
    const adapter = await gpu.requestAdapter();
    assert(adapter !== null);

    const requiredLimits: Record<string, number> = { unknownLimitName: 9000 };

    t.shouldReject('OperationError', adapter.requestDevice({ requiredLimits }));
  });

g.test('limits,supported')
  .desc(
    `
    Test that each supported limit can be specified with valid values.
    - Tests each limit with the default values given by the spec
    - Tests each limit with the supported values given by the adapter`
  )
  .params(u =>
    u.combine('limit', kLimits).beginSubcases().combine('limitValue', ['default', 'adapter'])
  )
  .fn(async t => {
    const { limit, limitValue } = t.params;

    const gpu = getGPU();
    const adapter = await gpu.requestAdapter();
    assert(adapter !== null);

    let value: number = -1;
    switch (limitValue) {
      case 'default':
        value = kLimitInfo[limit].default;
        break;
      case 'adapter':
        value = adapter.limits[limit];
        break;
    }

    const device = await adapter.requestDevice({ requiredLimits: { [limit]: value } });
    assert(device !== null);
    t.expect(
      device.limits[limit] === value,
      'Devices reported limit should match the required limit'
    );
    device.destroy();
  });

g.test('limit,better_than_supported')
  .desc(
    `
    Test that specifying a better limit than what the adapter supports causes requestDevice to
    reject.
    - Tests each limit
    - Tests requesting better limits by various amounts`
  )
  .params(u =>
    u
      .combine('limit', kLimits)
      .beginSubcases()
      .expandWithParams(p => {
        switch (kLimitInfo[p.limit].class) {
          case 'maximum':
            return [
              { mul: 1, add: 1 },
              { mul: 1, add: 100 },
            ];
          case 'alignment':
            return [
              { mul: 1, add: -1 },
              { mul: 1 / 2, add: 0 },
              { mul: 1 / 1024, add: 0 },
            ];
        }
      })
  )
  .fn(async t => {
    const { limit, mul, add } = t.params;

    const gpu = getGPU();
    const adapter = await gpu.requestAdapter();
    assert(adapter !== null);

    const value = adapter.limits[limit] * mul + add;
    const requiredLimits = {
      [limit]: clamp(value, { min: 0, max: kLimitInfo[limit].maximumValue }),
    };

    t.shouldReject('OperationError', adapter.requestDevice({ requiredLimits }));
  });

g.test('limit,worse_than_default')
  .desc(
    `
    Test that specifying a worse limit than the default values required by the spec cause the value
    to clamp.
    - Tests each limit
    - Tests requesting worse limits by various amounts`
  )
  .params(u =>
    u
      .combine('limit', kLimits)
      .beginSubcases()
      .expandWithParams(p => {
        switch (kLimitInfo[p.limit].class) {
          case 'maximum':
            return [
              { mul: 1, add: -1 },
              { mul: 1, add: -100 },
            ];
          case 'alignment':
            return [
              { mul: 1, add: 1 },
              { mul: 2, add: 0 },
              { mul: 1024, add: 0 },
            ];
        }
      })
  )
  .fn(async t => {
    const { limit, mul, add } = t.params;

    const gpu = getGPU();
    const adapter = await gpu.requestAdapter();
    assert(adapter !== null);

    const value = kLimitInfo[limit].default * mul + add;
    const requiredLimits = {
      [limit]: clamp(value, { min: 0, max: kLimitInfo[limit].maximumValue }),
    };

    let success;
    switch (kLimitInfo[limit].class) {
      case 'alignment':
        success = isPowerOfTwo(value);
        break;
      case 'maximum':
        success = true;
        break;
    }

    if (success) {
      const device = await adapter.requestDevice({ requiredLimits });
      assert(device !== null);
      t.expect(
        device.limits[limit] === kLimitInfo[limit].default,
        'Devices reported limit should match the default limit'
      );
      device.destroy();
    } else {
      t.shouldReject('OperationError', adapter.requestDevice({ requiredLimits }));
    }
  });
