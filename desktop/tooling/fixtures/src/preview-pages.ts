/** Local deterministic pages shared by preview regression tests and Desktop E2E. */
const cards = (ids: number[]) =>
  ids
    .map(
      (id) =>
        `<article class="preview-item"><h2>样本商品 ${id}</h2><span class="price">${40 + id}</span><a class="detail-link" href="/preview/detail/${id}">详情</a></article>`,
    )
    .join('');
export const previewFixturePages: Record<string, string> = {
  '/preview/static': `<!doctype html><html lang="zh-CN"><body><main>${cards([1, 2, 3])}</main></body></html>`,
  '/preview/dynamic': `<!doctype html><html lang="zh-CN"><body><main id="items">${cards([1])}</main><button id="next">加载下一组</button><script>document.querySelector('#next').onclick = () => { document.querySelector('#items').insertAdjacentHTML('beforeend', ${JSON.stringify(cards([2, 3]))}); document.querySelector('#next').remove(); };</script></body></html>`,
  '/preview/noise': `<!doctype html><html lang="zh-CN"><body>
    <nav><article class="preview-item"><h2>导航入口</h2></article></nav>
    <aside class="advertisement"><article class="preview-item"><h2>广告商品</h2><span class="price">5</span></article></aside>
    <main><article class="preview-item"><h2>正常商品</h2><span class="price">42</span></article>
    <article class="preview-item"><h2>空值商品</h2><span class="price"> </span></article>
    <article class="preview-item"><h2>异常商品</h2><span class="price">价格待协商</span></article></main></body></html>`,
  '/preview/ambiguous-links': `<!doctype html><html><body><article class="preview-item"><h2>歧义商品</h2><a class="detail-link" href="/preview/detail/1">基本详情</a><a class="detail-link" href="/preview/detail/2">推广详情</a></article></body></html>`,
  '/preview/ambiguous-records': `<!doctype html><html><body><article class="preview-item"><h2>歧义商品</h2><a class="detail-link" href="/preview/detail/ambiguous">详情</a></article></body></html>`,
  '/preview/detail/ambiguous':
    '<html><body><main class="detail"><p class="description">第一条</p></main><main class="detail"><p class="description">第二条</p></main></body></html>',
};
for (let id = 1; id <= 3; id++)
  previewFixturePages[`/preview/detail/${id}`] =
    `<!doctype html><html lang="zh-CN"><body><main class="detail"><p class="description">样本商品 ${id} 的详情</p></main></body></html>`;
