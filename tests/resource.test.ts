import assert from 'node:assert/strict';
import test from 'node:test';
import { placeResourceKey } from '../src/place-navigation';
import {
  currentResource,
  loadResource,
  type Resource,
  type ResourceLoader,
  type ResourceState,
} from '../src/resource';
import type { Place } from '../src/types';

const jakarta: Place = {
  id: '1642911',
  name: 'Jakarta',
  country: 'Indonesia',
  countryCode: 'ID',
  latitude: -6.21462,
  longitude: 106.84513,
  timezone: 'Asia/Jakarta',
  admin: 'Jakarta Special Capital Region',
};
const manila: Place = {
  id: '1701668',
  name: 'Manila',
  country: 'Philippines',
  countryCode: 'PH',
  latitude: 14.6042,
  longitude: 120.9822,
  timezone: 'Asia/Manila',
  admin: 'National Capital Region',
};
type Reply = {
  signal?: AbortSignal;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

/** Mirrors useResource: React state, one effect run per revision, and the rendered value. */
function harness() {
  const replies: Reply[] = [];
  const loader: ResourceLoader<string> = (_place, signal) =>
    new Promise((resolve, reject) => replies.push({ signal, resolve, reject }));
  let state: ResourceState<string> = {
    data: null,
    loading: true,
    error: null,
    key: placeResourceKey(jakarta),
    loader,
  };
  let cleanup = () => {};
  return {
    replies,
    /** A place change, the 60-second warning check, a 15-minute or deliberate refresh. */
    run(place: Place, enabled = true, use = loader) {
      cleanup();
      cleanup = loadResource(place, placeResourceKey(place), use, enabled, (next) => {
        state = next(state);
      });
    },
    view(place: Place, enabled = true, use = loader) {
      const { data, loading, error }: Resource<string> = currentResource(
        state,
        placeResourceKey(place),
        use,
        enabled,
      );
      return { data, loading, error };
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a refresh keeps the last successful result on screen while it runs and after it fails', async () => {
  const resource = harness();
  resource.run(jakarta);
  assert.deepEqual(resource.view(jakarta), { data: null, loading: true, error: null });
  resource.replies[0].resolve('Severe warning, checked 10:00');
  await settle();
  assert.deepEqual(resource.view(jakarta), {
    data: 'Severe warning, checked 10:00',
    loading: false,
    error: null,
  });

  // The automatic one-minute warning check for the same place.
  resource.run(jakarta);
  assert.deepEqual(
    resource.view(jakarta),
    { data: 'Severe warning, checked 10:00', loading: true, error: null },
    'the verified warning stays listed while the next check runs',
  );
  resource.replies[1].reject(new Error('Official warnings could not be verified.'));
  await settle();
  assert.deepEqual(
    resource.view(jakarta),
    {
      data: 'Severe warning, checked 10:00',
      loading: false,
      error: 'Official warnings could not be verified.',
    },
    'a failed check keeps the last successful result and reports the failure',
  );

  resource.run(jakarta);
  resource.replies[2].resolve('No warning, checked 10:02');
  await settle();
  assert.deepEqual(resource.view(jakarta), {
    data: 'No warning, checked 10:02',
    loading: false,
    error: null,
  });
});

test('another place, another loader or a disabled resource never shows the previous result', async () => {
  const resource = harness();
  resource.run(jakarta);
  resource.replies[0].resolve('Jakarta warnings');
  await settle();

  resource.run(manila);
  assert.deepEqual(resource.view(manila), { data: null, loading: true, error: null });
  resource.replies[1].reject(new Error('Manila feed unavailable'));
  await settle();
  assert.deepEqual(resource.view(manila), {
    data: null,
    loading: false,
    error: 'Manila feed unavailable',
  });

  resource.run(jakarta);
  resource.replies[2].resolve('Jakarta forecast');
  await settle();
  // Data saver and Full workspace request differently shaped forecasts for the same place.
  const compact: ResourceLoader<string> = () => new Promise(() => {});
  resource.run(jakarta, true, compact);
  assert.deepEqual(resource.view(jakarta, true, compact), {
    data: null,
    loading: true,
    error: null,
  });

  resource.run(jakarta);
  resource.replies[3].resolve('Jakarta forecast');
  await settle();
  // Offline: nothing is presented as current, and nothing returns when the connection does.
  resource.run(jakarta, false);
  assert.deepEqual(resource.view(jakarta, false), { data: null, loading: false, error: null });
  resource.run(jakarta);
  assert.deepEqual(resource.view(jakarta), { data: null, loading: true, error: null });
});

test('a superseded request is cancelled and cannot overwrite the newer place', async () => {
  const resource = harness();
  resource.run(jakarta);
  resource.run(manila);
  assert.equal(resource.replies[0].signal?.aborted, true);
  resource.replies[1].resolve('Manila warnings');
  resource.replies[0].resolve('Late Jakarta warnings');
  await settle();
  assert.deepEqual(resource.view(manila), {
    data: 'Manila warnings',
    loading: false,
    error: null,
  });
  resource.run(manila);
  resource.run(jakarta);
  resource.replies[2].reject(new Error('Aborted Manila check'));
  await settle();
  assert.deepEqual(resource.view(jakarta), { data: null, loading: true, error: null });
});
