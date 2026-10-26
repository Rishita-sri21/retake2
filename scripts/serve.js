// Local dev server with no dependencies: serves the static app and the
// /api functions the same way Vercel does.  Run: npm run dev
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // /api routes are not used by Retake.
  const api = url.pathname.match(/^\/api\/([a-z-]+)$/);
  if (api) {
    try {
      const mod = await import(join(root, 'api', `${api[1]}.js`));
      return await mod.default(req, res);
    } catch (err) {
      console.error(err);
      res.statusCode = 404;
      return res.end('Not found');
    }
  }

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (rel.startsWith('..')) {
    res.statusCode = 403;
    return res.end();
  }
  let file = join(root, rel || 'index.html');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`Retake running at http://localhost:${port}`);
});
