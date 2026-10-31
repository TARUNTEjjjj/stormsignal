import { createServer } from 'node:http';
import worker from '../dist/server/index.js';
const port = Number(process.env.PORT || 6185);
const server = createServer(async (req, res) => {
  try {
    const result = await worker.fetch(
      new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers: req.headers,
      }),
    );
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end('Preview request failed');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}/`));
