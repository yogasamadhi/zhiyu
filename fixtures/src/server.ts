import Fastify from 'fastify';

const app = Fastify({ logger: true });
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_request, body, done) => done(null, body),
);
const port = Number(process.env.FIXTURE_PORT ?? 45100);

const products = Array.from({ length: 30 }, (_, index) => ({
  id: index + 1,
  name: `织云商品 ${String(index + 1).padStart(2, '0')}`,
  price: 99 + index * 7.5,
  sales: 1200 - index * 17,
  description: `用于 ZhiYun 自动测试的商品 ${index + 1}`,
}));
const webhookDeliveries: unknown[] = [];

function productCards(items: typeof products): string {
  return items
    .map(
      (product) => `
      <article class="product-card" data-product-id="${product.id}">
        <a class="product-link" href="/products/${product.id}">
          <h2 class="product-title">${product.name}</h2>
        </a>
        <span class="price">¥${product.price.toFixed(2)}</span>
        <span class="sales">销量 ${product.sales}</span>
      </article>`,
    )
    .join('');
}

app.get('/robots.txt', async (_request, reply) => {
  reply.type('text/plain').send('User-agent: *\nAllow: /\n');
});

app.get('/products', async (request, reply) => {
  const query = request.query as { page?: string };
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = 10;
  const items = products.slice((page - 1) * pageSize, page * pageSize);
  const next =
    page * pageSize < products.length
      ? `<a class="next-page" href="/products?page=${page + 1}">下一页</a>`
      : '';
  reply.type('text/html').send(`<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><title>织云静态商品</title></head>
    <body><main><h1>静态商品列表</h1><section id="products">${productCards(items)}</section>${next}</main></body></html>`);
});

app.get<{ Params: { id: string } }>('/products/:id', async (request, reply) => {
  const product = products.find((item) => item.id === Number(request.params.id));
  if (!product) return reply.code(404).send({ error: 'Not found' });
  return reply.type('text/html').send(`<!doctype html><html lang="zh-CN"><body>
    <main class="product-detail"><h1>${product.name}</h1><p class="description">${product.description}</p>
    <span class="price">¥${product.price.toFixed(2)}</span><span class="sales">销量 ${product.sales}</span></main>
  </body></html>`);
});

app.get('/api/products', async (request) => {
  const query = request.query as { page?: string; limit?: string };
  const page = Math.max(1, Number(query.page ?? 1));
  const limit = Math.min(20, Math.max(1, Number(query.limit ?? 10)));
  return {
    items: products.slice((page - 1) * limit, page * limit).map((product) => ({
      ...product,
      url: `http://localhost:${port}/products/${product.id}`,
    })),
    page,
    total: products.length,
  };
});

app.get('/dynamic-products', async (_request, reply) => {
  reply.type('text/html').send(`<!doctype html>
  <html lang="zh-CN"><head><meta charset="utf-8"><title>织云动态商品</title>
  <style>body{font-family:system-ui;max-width:900px;margin:40px auto}.product-card{padding:16px;border:1px solid #ddd;margin:8px}.loading{color:#666}</style></head>
  <body><main><h1>动态商品列表</h1><p id="status" class="loading">正在加载…</p><section id="products"></section>
  <button id="load-more" style="display:none">加载更多</button><div id="sentinel"></div></main>
  <script>
    let page = 0; let loading = false;
    const list = document.querySelector('#products'); const button = document.querySelector('#load-more');
    async function loadMore() {
      if (loading || page >= 3) return; loading = true; page += 1;
      await new Promise(resolve => setTimeout(resolve, 350));
      const response = await fetch('/api/products?page=' + page + '&limit=10'); const payload = await response.json();
      for (const item of payload.items) {
        const article = document.createElement('article'); article.className = 'product-card';
        article.innerHTML = '<a class="product-link" href="' + item.url + '"><h2 class="product-title">' + item.name + '</h2></a>' +
          '<span class="price">¥' + Number(item.price).toFixed(2) + '</span> <span class="sales">销量 ' + item.sales + '</span>';
        list.append(article);
      }
      document.querySelector('#status').textContent = '已加载 ' + list.children.length + ' 条';
      button.style.display = page < 3 ? 'block' : 'none'; loading = false;
    }
    button.addEventListener('click', loadMore);
    new IntersectionObserver(entries => { if (entries[0].isIntersecting && page > 0) loadMore(); }).observe(document.querySelector('#sentinel'));
    setTimeout(loadMore, 500);
  </script></body></html>`);
});

app.get('/login', async (_request, reply) => {
  reply.type('text/html')
    .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Fixture 登录</title></head><body>
    <form method="post" action="/login"><h1>Fixture 登录</h1>
    <input name="username" value="zhiyun"><input name="password" type="password" value="fixture">
    <button type="submit">登录</button></form></body></html>`);
});

app.post('/login', async (_request, reply) => {
  return reply
    .header('set-cookie', 'zhiyun_session=fixture-authenticated; Path=/; HttpOnly; SameSite=Lax')
    .redirect('/private-products');
});

app.get('/private-products', async (request, reply) => {
  if (!String(request.headers.cookie ?? '').includes('zhiyun_session=fixture-authenticated')) {
    return reply.code(401).type('text/html').send('<h1>请先登录</h1>');
  }
  return reply.type('text/html')
    .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录后商品</title></head><body>
    <main><h1>登录后商品</h1><section>${productCards(products.slice(0, 10))}</section></main>
  </body></html>`);
});

app.post('/webhook', async (request, reply) => {
  webhookDeliveries.push({ body: request.body, headers: request.headers });
  return reply.code(202).send({ accepted: true });
});

app.get('/webhook-deliveries', async () => ({ items: webhookDeliveries }));

await app.listen({ host: '0.0.0.0', port });
