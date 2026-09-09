import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
const transport = vi.hoisted(() => ({ url: '' }));
// Route only the transport to a local HTTP server. Node's real IncomingMessage
// and request lifecycle exercise abrupt/truncated/malformed responses; the
// production URL validation is still applied before opening this connection.
vi.mock('node:https', async () => {
  const http = await import('node:http');
  return { get: (_url: URL, options: object, callback: Parameters<typeof http.get>[1]) => http.get(transport.url, options, callback as never) };
});
import { fetchRegistryArchive } from '../src/export-shared.js';
const servers: Server[] = [];
async function listen(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  transport.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/archive.tgz`;
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
const pinned = 'https://registry.npmjs.org/example/-/example-1.0.0.tgz';

test('returns exactly the completed archive response bytes', async () => {
  await listen((_request, response) => { response.writeHead(200, { 'Content-Length': '4' }); response.end('data'); });
  expect(await fetchRegistryArchive(pinned, 1000)).toEqual(Buffer.from('data'));
});
test('rejects a truncated response without waiting for the archive deadline', async () => {
  await listen((_request, response) => { response.writeHead(200, { 'Content-Length': '99' }); response.write('short'); setImmediate(() => response.destroy()); });
  await expect(fetchRegistryArchive(pinned, 1000)).rejects.toThrow();
});
test('rejects a malformed response before accepting any archive bytes', async () => {
  await listen((request, _response) => { request.socket.write('invalid HTTP response\r\n\r\n'); request.socket.end(); });
  await expect(fetchRegistryArchive(pinned, 1000)).rejects.toThrow();
});
test('does not follow a redirect', async () => {
  await listen((_request, response) => { response.writeHead(302, { Location: 'https://private.invalid/secret' }); response.end(); });
  await expect(fetchRegistryArchive(pinned, 1000)).rejects.toThrow(/redirected/);
});
test('a stalled response is bounded by the remaining acquisition deadline', async () => {
  await listen((_request, response) => { response.writeHead(200); response.write('partial'); });
  await expect(fetchRegistryArchive(pinned, 100)).rejects.toThrow(/deadline/);
});
test('rejects a response exceeding the archive byte limit', async () => {
  await listen((_request, response) => { response.writeHead(200); response.end(Buffer.alloc(16 * 1024 * 1024 + 1)); });
  await expect(fetchRegistryArchive(pinned, 1000)).rejects.toThrow(/16 MiB/);
});
test.each(['https://private.invalid/archive.tgz', 'https://user:secret@registry.npmjs.org/a.tgz', 'https://registry.npmjs.org/a.tgz?token=secret'])('rejects unqualified source before opening the transport: %s', async url => {
  transport.url = 'http://127.0.0.1:1';
  await expect(fetchRegistryArchive(url, 1000)).rejects.toThrow(/explicit archive/);
});
