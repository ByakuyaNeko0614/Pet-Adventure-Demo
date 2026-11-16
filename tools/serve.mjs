import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const port = Number(process.env.PORT || 5173);
const contentTypes = { html: 'text/html', css: 'text/css', js: 'text/javascript', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', mp3: 'audio/mpeg', wav: 'audio/wav' };

createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const file = path === '/' ? 'hatch.html' : path.slice(1);
  if (!['GET', 'HEAD'].includes(request.method) ||
    !/^(?:(?:hatch|nursery|adventure|shop)\.html|(?:core|web)\/[a-z]+\.(?:css|js)|web\/assets\/[a-z0-9-]+\.(?:png|webp|jpg|mp3|wav))$/.test(file)) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(new URL(file, root));
    response.writeHead(200, { 'Content-Type': contentTypes[file.split('.').at(-1)] + '; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const missing = error.code === 'ENOENT';
    response.writeHead(missing ? 404 : 500).end(missing ? 'Not found' : 'Server error');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`寵物尋寶 Demo　http://127.0.0.1:${port}/`);
});
