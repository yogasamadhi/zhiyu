/** Bundled teaching content shared by the UI and the deterministic extraction executor. */
export const assistantExampleProducts = [
  { name: '轻行双肩包', category: '出行', price: 249, stock: 32 },
  { name: '白瓷咖啡杯', category: '生活', price: 59, stock: 120 },
  { name: '折叠阅读灯', category: '办公', price: 169, stock: 48 },
  { name: '棉麻收纳篮', category: '生活', price: 89, stock: 65 },
  { name: '随行保温杯', category: '出行', price: 129, stock: 0 },
  { name: '桌面记事本', category: '办公', price: 39, stock: 200 },
] as const;
export const assistantExampleHtml = `<main>${assistantExampleProducts.map((p, i) => `<article class="product"><h2>${p.name}</h2><span class="category">${p.category}</span><span class="price">${p.price}</span><span class="stock">${p.stock}</span><a href="/products/${i + 1}">详情</a></article>`).join('')}</main>`;
export function assistantExamplePage(pages: number) {
  return assistantExampleProducts.slice(0, Math.max(1, Math.min(2, pages)) * 3);
}
