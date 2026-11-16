import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const output = new URL('dist/gas/', root);
const read = path => readFile(new URL(path, root), 'utf8');
const write = (path, content) => writeFile(new URL(path, output), content, 'utf8');

await mkdir(output, { recursive: true });
const shared = ['rules', 'maze', 'decision', 'adventure', 'store'];
const scripts = await Promise.all(shared.map(name => read(`core/${name}.js`)));
await write('Core.gs', scripts.join('\n\n'));
await Promise.all(['Code.gs', 'Accounts.gs', 'SheetsStore.gs', 'appsscript.json'].map(name =>
  copyFile(new URL(`gas/${name}`, root), new URL(name, output))));

const crypto = await build({
  stdin: { resolveDir: fileURLToPath(root), contents: `
    import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
    import { sha256 } from '@noble/hashes/sha2.js';
    import { bytesToHex } from '@noble/hashes/utils.js';
    const bytes = value => Uint8Array.from(Utilities.newBlob(value).getBytes());
    export const digest = text => bytesToHex(sha256(bytes(text)));
    export const passwordHash = (password, salt, c) =>
      bytesToHex(pbkdf2(sha256, bytes(password), bytes(salt), { c, dkLen: 32 }));
  ` },
  bundle: true, platform: 'browser', format: 'iife', target: 'es2020', globalName: 'AccountCrypto',
  minify: true, write: false
});
const license = await read('node_modules/@noble/hashes/LICENSE');
await write('AccountCrypto.gs', '/*\n' + license.trim() + '\n*/\n' + crypto.outputFiles[0].text);

const dataUrl = async (asset, mime) => 'data:' + mime + ';base64,' +
  (await readFile(new URL('web/assets/' + asset, root))).toString('base64');
let style = await read('web/style.css');
const imageEntries = [...new Set([...style.matchAll(/url\('assets\/([a-z0-9-]+\.(?:webp|jpg))'\)/g)].map(match => match[1]))];
const imageVars = await Promise.all(imageEntries.map(async asset => {
  const variable = '--gas-' + asset.split('.')[0];
  style = style.replaceAll(`url('assets/${asset}')`, `var(${variable})`);
  const url = await dataUrl(asset, asset.endsWith('.jpg') ? 'image/jpeg' : 'image/webp');
  return `${variable}:url(${url});`;
}));
await write('GameStyles.html', '<style>\n:root{' + imageVars.join('') + '}\n' + style + '\n</style>');

const accountMarkup = await read('gas/AccountGate.html');
const accountScript = await read('web/account.js');
for (const [page, name] of [['hatch', 'Hatch'], ['nursery', 'Nursery'], ['adventure', 'Adventure'], ['shop', 'Shop']]) {
  let html = (await read(page + '.html')).replace('data-mode="demo"', 'data-mode="sheets"')
    .replace('<head>', '<head>\n  <base href="<?= appUrl ?>" target="_top">')
    .replace(/href="(hatch|nursery|adventure|shop)\.html"/g, 'href="?page=$1"')
    .replace(`<body data-page="${page}">`, `<body data-page="${page}" class="account-locked">\n${accountMarkup.replace('PAGE_ROUTE', page)}`)
    .replace('<link rel="stylesheet" href="web/style.css">', "<?!= include_('GameStyles') ?>");
  for (const [tag, path] of html.matchAll(/<script defer src="([^"]+)"><\/script>/g)) {
    let source = (await read(path)).replace(/<\/script/gi, '<\\/script');
    if (path === 'web/audio.js') {
      const audio = page === 'hatch'
        ? ['home-theme.mp3', 'conservatory-theme.mp3', 'loft-theme.mp3'] : ['forest-theme.mp3'];
      for (const asset of audio) source = source.replace('web/assets/' + asset, await dataUrl(asset, 'audio/mpeg'));
    }
    html = html.replace(tag, () => `<script type="text/plain" data-game-script>\n${source}\n</script>`);
  }
  html = html.replace('</body>', () => `<script>\n${accountScript}\nAccount.start();\n</script>\n</body>`);
  await write(name + '.html', html);
}
console.log('Apps Script 匯入檔已建立於 dist/gas/');
