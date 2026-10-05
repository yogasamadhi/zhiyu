import type { AssistantLesson } from '@zhiyun/contracts';

const help = [
  [
    'fields',
    '字段与记录',
    'Fields and records',
    '表格的一列叫字段，一行是一条记录。先确定一行代表一个商品还是一条评论，再选择名称、价格等列。',
    'A field is a table column; a record is one row. Decide whether a row represents a product or a review, then choose the columns.',
  ],
  [
    'source',
    '寻找数据来源',
    'Find a source',
    '可以粘贴已有网页，或告诉我希望得到什么数据。搜索结果只是候选，选择来源后还要检查页面。无法访问时可换公开来源或体验内置样例。',
    'Paste a page or describe the data you need. Search results are candidates; select a source before inspecting it. Try another public source or the bundled example when access is unavailable.',
  ],
  [
    'pagination',
    '分页与采集范围',
    'Pagination and scope',
    '网页可能只显示第一页。下一页、加载更多、向下滚动都是继续加载数据的方式。预览只检查少量页面，不代表正式采集的总量。',
    'A page may show only the first batch. Next page, load more, and scrolling can reveal additional records. A small preview does not establish the total available data.',
  ],
  [
    'preview',
    '检查预览',
    'Check a preview',
    '检查每列是否是你想要的内容，价格是否为数值，有没有空值。修改字段后要重新预览。少量样本正确不代表全量都正确。',
    'Check column contents, numeric prices and missing values. Preview again after changing fields. A correct sample does not guarantee all records are correct.',
  ],
  [
    'login',
    '页面要求登录',
    'Login required',
    '桌面版可在草稿页面打开安全登录窗口，登录后重新预览；网页版本使用受保护的手动凭据配置。不要把密码、Cookie 或 Token 发到聊天里。',
    'On desktop, open secure login from the draft and preview again. On web, use protected manual credential settings. Never paste passwords, cookies or tokens into chat.',
  ],
  [
    'schedule',
    '定时更新',
    'Scheduled updates',
    '先确认首次结果，再设置多久更新一次。执行卡会显示频率与时区。只想体验时保持手动运行。',
    'Check the first result before scheduling updates. The action card shows the frequency and timezone. Keep manual execution for practice.',
  ],
  [
    'export',
    '导出与分析',
    'Export and analyze',
    '在数据集页面选择需要的字段、筛选条件和 CSV、JSON 或 XLSX 格式。分析使用一个确定的数据版本，服务不可用时仍可查看已有结果。',
    'Choose columns, filters and CSV, JSON or XLSX on the dataset page. Analysis uses a fixed snapshot. Existing results remain available when the worker is unavailable.',
  ],
  [
    'empty',
    '空结果或字段缺失',
    'Empty or missing fields',
    '先检查来源和登录状态，再检查字段是否仍存在、页面是否变更、是否需要浏览器加载。修复后先预览，不直接替换正在使用的规则。',
    'Check the source and login state, then field presence, page changes and browser loading. Preview repairs before replacing an active rule.',
  ],
  [
    'output',
    '采集成功但输出失败',
    'Delivery failed after collection',
    '已有采集数据不需要重新抓取。检查输出连接后，仅重试失败的输出投递。',
    'Collected data does not need to be collected again. Check the destination, then retry only the failed delivery.',
  ],
  [
    'model',
    '连接模型',
    'Connect a model',
    '在设置的 AI 模型中选择服务商、填写密钥并测试连接。没有模型时仍可使用固定引导与离线样例，完成设置后返回原会话。',
    'Select a provider, enter its key and test the connection in AI settings. Fixed guidance and offline examples work without a model; return to the same conversation after setup.',
  ],
] as const;
export function searchAssistantHelp(query: string, language: 'zh' | 'en') {
  const normalized = query.toLowerCase();
  const words = [
    ...normalized.split(/[\s，。？?]+/).filter(Boolean),
    ...(normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? []).flatMap((word) =>
      Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)),
    ),
  ];
  return help
    .map(([id, zh, en, textZh, textEn]) => ({
      id,
      title: language === 'zh' ? zh : en,
      text: language === 'zh' ? textZh : textEn,
      version: 1,
      score: words.reduce(
        (score, word) =>
          score + (`${id} ${zh} ${en} ${textZh} ${textEn}`.toLowerCase().includes(word) ? 1 : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}
export function assistantLessons(language: 'zh' | 'en'): AssistantLesson[] {
  const zh = language === 'zh';
  const step = (
    activity: AssistantLesson['steps'][number]['activity'],
    title: string,
    enTitle: string,
    explanation: string,
    en: string,
    demonstration: string,
  ) => ({
    activity,
    title: zh ? title : enTitle,
    explanation: zh ? explanation : en,
    demonstration,
  });
  const example = step(
    'example',
    '准备内置商品样例',
    'Prepare the product example',
    '点击创建样例卡。它使用随产品提供的固定内容，不访问外部网站。',
    'Click the example action card. It uses bundled content without contacting an external site.',
    '名称 / Name · 价格 / Price',
  );
  const preview = step(
    'preview',
    '检查真实提取结果',
    'Check extraction results',
    '点击检查预览，观察名称和价格是否正确。完成状态来自服务端预览。',
    'Preview the extraction and check the names and prices. Completion is verified from the server result.',
    '轻行双肩包 → 249',
  );
  return [
    {
      id: 'first-table',
      version: 1,
      title: zh ? '从样例到第一张表' : 'Your first table',
      summary: zh ? '认识来源、字段和预览。' : 'Learn sources, columns and previews.',
      steps: [example, preview],
    },
    {
      id: 'fields',
      version: 1,
      title: zh ? '字段与点选' : 'Fields and selection',
      summary: zh
        ? '在固定练习中选择价格，再验证字段。'
        : 'Select a price in the bundled exercise and verify it.',
      steps: [
        example,
        step(
          'select_price',
          '点选价格文字',
          'Select the price',
          '选择价格数字。整张卡片会包含额外内容；点中价格后服务端会更新样例规则。',
          'Select the price number. A whole card includes extra content. A price selection updates the example rule on the server.',
          '249',
        ),
        preview,
      ],
    },
    {
      id: 'pagination',
      version: 1,
      title: zh ? '分页与加载更多' : 'Pagination and load more',
      summary: zh
        ? '理解第一页和完整范围的区别。'
        : 'Understand the first page and the full range.',
      steps: [
        step(
          'pagination',
          '加载第二批商品',
          'Load the next batch',
          '固定练习每批 3 条，一共 2 批。点击加载更多，服务端会核对你看到的范围。',
          'This exercise has two batches of three products. Load more to inspect the complete range.',
          '3 → 6',
        ),
      ],
    },
    {
      id: 'export',
      version: 1,
      title: zh ? '导出与再次运行' : 'Export and run again',
      summary: zh ? '保存、运行，再导出已获得的数据。' : 'Save, run and export the collected data.',
      steps: [
        example,
        preview,
        step(
          'run',
          '保存并运行',
          'Save and run',
          '点击保存并运行卡，等待后台实际完成。',
          'Click Save and run and wait for the actual job to finish.',
          'CSV / JSON / XLSX',
        ),
        step(
          'export',
          '导出数据',
          'Export the data',
          '执行导出卡后点击下载文件。完成依据是服务端已生成导出文件，不代表文件已保存到你的设备。',
          'Execute the export card, then download the file. Completion verifies server-side file generation, not saving on your device.',
          'CSV',
        ),
      ],
    },
  ];
}
