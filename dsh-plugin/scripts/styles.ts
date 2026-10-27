import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postcss from 'postcss';
import prefix from 'postcss-prefix-selector';
const root = resolve(import.meta.dirname, '..');
const sources = ['tokens.css', 'foundation.css', 'workspace.css', 'features.css'];
let css = '';
for (const file of sources)
  css += await readFile(resolve(root, '../desktop/packages/ui-sdk/src/styles', file), 'utf8');
for (const file of ['components/analysis/analysis.css', 'components/dataset-cleaning/cleaning.css'])
  css += await readFile(resolve(root, '../desktop/packages/ui-sdk/src', file), 'utf8');
const result = await postcss([
  prefix({
    prefix: '.zhiyun-workbench',
    transform(_prefix, selector, prefixed) {
      if (/^(?:html|body|:root)/.test(selector))
        return selector.replace(/^(?:html|body|:root)/, '.zhiyun-workbench');
      return prefixed;
    },
  }),
]).process(css, { from: undefined });
await writeFile(
  resolve(root, 'lib/workbench.css'),
  result.css +
    '\n.zhiyun-workbench{height:100%;overflow:auto;padding:24px;isolation:isolate}.zhiyun-header,.zhiyun-nav{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:20px}.zhiyun-header{justify-content:space-between}.zhiyun-page{max-width:1440px;margin:auto}.zhiyun-workbench textarea{display:block;width:100%;min-height:120px}.zhiyun-workbench label{display:block;margin:12px 0}\n',
);
