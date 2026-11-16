import assert from 'node:assert/strict';
import { test } from 'node:test';
import config from '../vite.config';

type Reply = { status?: number; headers?: Record<string, string>; body?: string };
type Middleware = (
  request: { method: string; url: string },
  response: {
    writeHead(status: number, headers: Record<string, string>): void;
    end(body: Buffer): void;
  },
  next: (error?: unknown) => void,
) => unknown;

// The warning API as `npm run dev` mounts it. Only configureServer runs: the build hooks of the
// other plugins write to dist/.
function warningApi(): Middleware {
  const plugin = (config.plugins ?? [])
    .flat()
    .find((entry) => !!entry && 'name' in entry && entry.name === 'official-warning-api') as
    { configureServer(server: unknown): void } | undefined;
  assert.ok(plugin, 'the dev server mounts the warning API');
  let mounted: Middleware | undefined;
  plugin.configureServer({
    middlewares: {
      use(route: string, middleware: Middleware) {
        assert.equal(route, '/api/alerts');
        mounted = middleware;
      },
    },
  });
  assert.ok(mounted);
  return mounted;
}

async function call(method: string, url = '/') {
  const reply: Reply = {};
  const errors: unknown[] = [];
  // Connect drops the promise an async middleware returns, so a rejection here is an unhandled
  // one in the dev server: Node then ends the process.
  await warningApi()(
    { method, url },
    {
      writeHead(status, headers) {
        reply.status = status;
        reply.headers = headers;
      },
      end(body) {
        reply.body = body.toString();
      },
    },
    (error) => errors.push(error),
  );
  return { reply, errors };
}

test('the dev warning API answers a request it cannot represent instead of ending the dev server', async () => {
  // Node's HTTP parser accepts TRACE; the Request constructor refuses it.
  assert.throws(() => new Request('http://localhost/api/alerts', { method: 'TRACE' }), TypeError);
  const trace = await call('TRACE');
  assert.equal(trace.errors.length, 1, 'the failure goes to the dev server error handler');
  assert.ok(trace.errors[0] instanceof TypeError);
  assert.equal(trace.reply.status, undefined, 'the error handler writes the response');
});

test('the dev warning API still answers ordinary requests itself', async () => {
  const invalid = await call('GET', '/?lat=bad&lon=0&country=US');
  assert.deepEqual(invalid.errors, []);
  assert.equal(invalid.reply.status, 400);
  assert.equal(JSON.parse(invalid.reply.body ?? '').error, true);
  const write = await call('POST');
  assert.deepEqual(write.errors, []);
  assert.equal(write.reply.status, 405);
  assert.equal(write.reply.headers?.allow, 'GET');
});
