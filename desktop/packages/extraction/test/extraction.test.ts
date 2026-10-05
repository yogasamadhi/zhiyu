import { describe, expect, it } from 'vitest';
import { extractData } from '../src/index.js';

const html = `
  <article class="product"><a href="/p/1"><span class="name">Cloud Loom</span></a><b class="price">¥1,299</b></article>
  <article class="product"><a href="/p/2"><span class="name">Data Shuttle</span></a><b class="price">¥99</b></article>`;

describe('extractData', () => {
  it('extracts and converts CSS fields', () => {
    const result = extractData(
      html,
      {
        type: 'css',
        container: '.product',
        fields: {
          name: { selector: '.name', value: 'text', dataType: 'string' },
          price: { selector: '.price', value: 'text', dataType: 'number' },
          url: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
        },
      },
      'http://fixture.test/products',
    );
    expect(result.records).toEqual([
      { name: 'Cloud Loom', price: 1299, url: 'http://fixture.test/p/1' },
      { name: 'Data Shuttle', price: 99, url: 'http://fixture.test/p/2' },
    ]);
  });

  it('extracts XPath fields', () => {
    const result = extractData(
      html,
      {
        type: 'xpath',
        container: "//article[contains(@class, 'product')]",
        fields: { name: { selector: ".//span[@class='name']", value: 'text', dataType: 'string' } },
      },
      'http://fixture.test/products',
    );
    expect(result.records.map((record) => record.name)).toEqual(['Cloud Loom', 'Data Shuttle']);
  });

  it('stores a stable one-based DOM container index', () => {
    const result = extractData(
      html,
      {
        type: 'css',
        container: '.product',
        fields: {
          rank: { selector: ':scope', value: 'index', dataType: 'number' },
          name: { selector: '.name', value: 'text', dataType: 'string' },
        },
      },
      'http://fixture.test/products',
    );
    expect(result.records).toEqual([
      { rank: 1, name: 'Cloud Loom' },
      { rank: 2, name: 'Data Shuttle' },
    ]);
  });

  it('extracts JSONPath fields', () => {
    const result = extractData(
      { items: [{ name: 'Loom', price: '42' }] },
      {
        type: 'json',
        container: '$.items[*]',
        fields: {
          name: { path: '$.name', dataType: 'string' },
          price: { path: '$.price', dataType: 'number' },
        },
      },
      'http://fixture.test/api/products',
    );
    expect(result.records).toEqual([{ name: 'Loom', price: 42 }]);
  });

  it('extracts structured values from a JSON assignment inside a script without evaluating it', () => {
    const page = `
      <html><body><script>
        window.untrusted = () => { throw new Error('must not execute'); };
        _ROUTER_DATA = {"loaderData":{"detail":{"id":"42","tags":["都市","成长"],"cast":[{"name":"演员甲","role":"主角"}]}}};
        window.after = true;
      </script></body></html>`;
    const result = extractData(
      page,
      {
        type: 'json',
        container: '$.loaderData.detail',
        fields: {
          id: { path: '$.id', dataType: 'string' },
          tags: { path: '$.tags', dataType: 'json' },
          cast: { path: '$.cast', dataType: 'json' },
        },
      },
      'https://fixture.test/detail/42',
      {
        type: 'script-json-assignment',
        selector: 'script',
        marker: '_ROUTER_DATA =',
      },
    );
    expect(result.records).toEqual([
      {
        id: '42',
        tags: ['都市', '成长'],
        cast: [{ name: '演员甲', role: '主角' }],
      },
    ]);
  });

  it('rejects malformed embedded JSON assignments', () => {
    expect(() =>
      extractData(
        '<script>_ROUTER_DATA = {"broken": true;</script>',
        {
          type: 'json',
          container: '$',
          fields: { broken: { path: '$.broken', dataType: 'json' } },
        },
        'https://fixture.test/detail',
        {
          type: 'script-json-assignment',
          selector: 'script',
          marker: '_ROUTER_DATA =',
        },
      ),
    ).toThrow('Could not extract data');
  });
});
