import type { i18n } from 'i18next';
const methods: Record<string, [string, string, string, string]> = {
  'data.profile': [
    '数据概况',
    'Data profile',
    '了解记录数量、字段类型与分布。',
    'Inspect row counts, field types and distributions.',
  ],
  'data.missing_duplicates': [
    '缺失与重复检查',
    'Missing values & duplicates',
    '找出缺失字段和重复记录。',
    'Find missing values and duplicate records.',
  ],
  'stats.descriptive': [
    '数值统计',
    'Descriptive statistics',
    '查看均值、中位数、范围和离散程度。',
    'Compare averages, medians, ranges and variation.',
  ],
  'category.frequency': [
    '分类频次',
    'Category frequency',
    '比较不同类别的数量和占比。',
    'Compare counts and shares across categories.',
  ],
  'group.aggregate': [
    '分组汇总',
    'Group aggregation',
    '按类别分组，汇总数值指标。',
    'Group data and aggregate numeric measures.',
  ],
  'stats.correlation': [
    '相关性分析',
    'Correlation',
    '查看数值字段之间的关联程度。',
    'Explore relationships between numeric fields.',
  ],
  'stats.outliers': [
    '异常值检测',
    'Outlier detection',
    '用统计规则识别偏离常态的数值。',
    'Identify unusual values using statistical rules.',
  ],
  'time.trend': [
    '时间趋势',
    'Time trend',
    '按时间汇总，观察变化和移动平均。',
    'Aggregate over time and inspect moving averages.',
  ],
  'text.profile': [
    '文本概况',
    'Text profile',
    '了解文本长度、常见词与语言分布。',
    'Inspect text lengths, frequent words and languages.',
  ],
  'data.quality_report': [
    '数据质量报告',
    'Data quality report',
    '综合检查完整性、重复情况和质量。',
    'Review completeness, duplicates and data quality.',
  ],
  'stats.hypothesis_test': [
    '组间差异检验',
    'Hypothesis testing',
    '检验不同分组的差异是否显著。',
    'Test whether groups differ significantly.',
  ],
  'stats.regression': [
    '回归分析',
    'Regression',
    '估计多个数值因素与目标指标的关系。',
    'Estimate relationships between factors and a target.',
  ],
  'time.arima': [
    '时间序列预测',
    'Time-series forecast',
    '根据历史序列生成预测及不确定性区间。',
    'Forecast from historical observations with uncertainty intervals.',
  ],
  'ml.clustering': [
    '相似记录分组',
    'Clustering',
    '根据数值特征发现相似记录。',
    'Discover similar records from numeric features.',
  ],
  'ml.pca': [
    '主要特征分析',
    'Principal component analysis',
    '用更少的维度描述数值特征的变化。',
    'Describe numeric variation in fewer dimensions.',
  ],
  'ml.isolation_forest': [
    '多维异常发现',
    'Multivariate anomaly detection',
    '结合多个数值特征发现异常记录。',
    'Find unusual records across multiple numeric features.',
  ],
  'text.tfidf': [
    '关键词提取',
    'Keyword extraction',
    '提取能区分不同文档的关键词。',
    'Extract terms that distinguish documents.',
  ],
  'text.classification': [
    '文本分类',
    'Text classification',
    '根据已标注文本训练分类模型并评估效果。',
    'Train and evaluate a classifier using labeled text.',
  ],
};
const parameters: Record<string, string> = {
  keyFields: '唯一键字段',
  fields: '分析字段',
  field: '分析字段',
  topN: '展示前 N 项',
  groupFields: '分组字段',
  valueFields: '数值字段',
  aggregations: '汇总方式',
  method: '计算方法',
  threshold: '异常阈值',
  timeField: '日期字段',
  valueField: '数值字段',
  interval: '时间间隔',
  aggregation: '汇总方式',
  movingAverage: '移动平均窗口',
  test: '检验方法',
  groupField: '分组字段',
  categoryField: '类别字段',
  outcomeField: '结果字段',
  alpha: '显著性水平',
  targetField: '目标字段',
  featureFields: '特征字段',
  model: '模型',
  family: '分布类型',
  order: '模型阶数',
  forecastSteps: '预测期数',
  algorithm: '算法',
  clusters: '分组数量',
  eps: '邻域距离',
  minSamples: '最小样本数',
  seed: '随机种子',
  components: '保留维度',
  contamination: '预计异常比例',
  textFields: '文本字段',
  maxFeatures: '最大特征数',
  testSize: '测试数据比例',
};
const options: Record<string, string> = {
  count: '计数',
  sum: '求和',
  mean: '平均值',
  min: '最小值',
  max: '最大值',
  median: '中位数',
  pearson: '皮尔逊相关',
  spearman: '斯皮尔曼秩相关',
  iqr: '四分位距',
  zscore: '标准分数',
  hour: '小时',
  day: '天',
  week: '周',
  month: '月',
  ttest: 't 检验',
  mannwhitney: '曼–惠特尼检验',
  chi_square: '卡方检验',
  anova: '方差分析',
  ols: '普通最小二乘',
  glm: '广义线性模型',
  gaussian: '正态分布',
  binomial: '二项分布',
  poisson: '泊松分布',
  kmeans: 'K 均值',
  dbscan: '密度聚类',
  logistic_regression: '逻辑回归',
  linear_svm: '线性支持向量机',
};
const outputs: Record<string, string> = {
  rowCount: '记录数',
  columnCount: '字段数',
  qualityScore: '质量评分',
  missingRate: '缺失率',
  duplicateRate: '重复率',
  missingCount: '缺失数量',
  duplicateCount: '重复数量',
  field: '字段',
  type: '类型',
  count: '数量',
  mean: '平均值',
  median: '中位数',
  min: '最小值',
  max: '最大值',
  std: '标准差',
  nullCount: '空值数量',
  uniqueCount: '不同值数量',
  frequency: '频次',
  percentage: '占比',
  score: '得分',
  value: '数值',
  label: '类别',
  cluster: '分组',
  coefficient: '系数',
  pValue: 'P 值',
  accuracy: '准确率',
  precision: '精确率',
  recall: '召回率',
  f1: 'F1 分数',
  profile: '数据概况',
  missing: '缺失值',
  duplicates: '重复记录',
  descriptive: '描述统计',
  groups: '分组比较结果',
  outlierSummary: '异常统计',
  outlierSamples: '异常记录',
  correlation: '相关性',
  outliers: '异常记录',
  trend: '时间趋势',
  forecast: '预测结果',
  keywords: '关键词',
  classification: '分类结果',
  metrics: '评估指标',
};
export function registerAnalyticsLabels(instance: i18n) {
  for (const locale of ['zh-CN', 'en']) {
    const zh = locale === 'zh-CN',
      nested: Record<string, unknown> = {};
    for (const [id, labels] of Object.entries(methods)) {
      const [group, key] = id.split('.') as [string, string];
      const category = (nested[group] ??= {}) as Record<string, unknown>;
      category[key] = { title: labels[zh ? 0 : 1], description: labels[zh ? 2 : 3] };
    }
    instance.addResourceBundle(
      locale,
      'translation',
      {
        analytics: {
          questionsTitle: zh ? '你想了解什么？' : 'What would you like to explore?',
          downloadArtifact: zh ? '保存结果文件' : 'Save result file',
          questionsHint: zh
            ? '根据所选数据版本推荐字段。运行时保存分析方案，可再次使用。'
            : 'Fields are recommended from this data version. Running saves a reusable recipe.',
          questions: zh
            ? {
                'group-comparison': { title: '分组比较', hint: '比较不同组的数值均值。' },
                'time-trend': { title: '时间趋势', hint: '按时间汇总数值或记录数量。' },
                distribution: { title: '数值分布', hint: '查看范围、四分位数和箱线图。' },
                outliers: { title: '异常点', hint: '定位超出阈值的记录。' },
              }
            : {
                'group-comparison': {
                  title: 'Compare groups',
                  hint: 'Compare mean values across groups.',
                },
                'time-trend': {
                  title: 'Time trend',
                  hint: 'Aggregate values or record counts over time.',
                },
                distribution: {
                  title: 'Value distribution',
                  hint: 'Inspect ranges, quartiles and a box plot.',
                },
                outliers: { title: 'Outliers', hint: 'Find records outside the chosen threshold.' },
              },
          questionReasons: zh
            ? {
                methodUnavailable: '分析方法暂不可用。',
                noFields: '此版本没有可用字段。',
                noDate: '缺少时间字段，请先转换日期或选择其他版本。',
                noNumber: '缺少数值字段，请先转换数字或选择其他版本。',
              }
            : {
                methodUnavailable: 'This method is unavailable.',
                noFields: 'This version has no fields.',
                noDate: 'No date field. Convert dates or choose another version.',
                noNumber: 'No numeric field. Convert numbers or choose another version.',
              },
          invalidParameters: zh
            ? '请补齐必选字段，并检查参数范围与字段类型。'
            : 'Complete required fields and check parameter bounds and field types.',
          paging: zh ? '结果分页' : 'Result pagination',
          pageRange: zh
            ? '{{start}}–{{end}} / 共 {{total}} 行'
            : '{{start}}–{{end}} of {{total}} rows',
          previousPage: zh ? '上一页' : 'Previous page',
          nextPage: zh ? '下一页' : 'Next page',
          emptyTable: zh ? '此结果表没有记录。' : 'This result table has no records.',
          chartLabel: zh ? '{{name}} 图表' : '{{name}} chart',
          chartPreview: zh
            ? '图表显示当前页的数据；可翻页查看更多。表格保留完整结果。'
            : 'The chart displays this page. Use pagination to explore more; tables retain all results.',
          chartFailed: zh
            ? '图表加载或渲染失败。分析解释和结果表格仍可查看；加载失败时可重新打开页面。'
            : 'The chart could not load or render. Explanations and tables remain available. Reopen the page if loading failed.',
          retryChart: zh ? '重试图表' : 'Retry chart',
          unsupportedChart: zh
            ? '此图表类型暂不支持，请查看结果表格。'
            : 'This chart type is not supported. Use the result tables.',
          missingEncoding: zh
            ? '此结果缺少明确的图表字段映射，请查看表格。'
            : 'This result lacks an explicit chart field mapping. Use the tables.',
          emptyChart: zh
            ? '当前页没有可绘制的数值，请查看表格或其他页。'
            : 'This page has no plottable values. Use the tables or another page.',
          frozenInput: zh ? '本次分析的固定输入' : 'Frozen analysis input',
          frozenHint: zh
            ? '输入版本和参数在运行时保存。修改分析方案不会改变这个结果。'
            : 'The input version and parameters were saved for this run. Editing a recipe does not change this result.',
          frozenDatasetHint: zh
            ? '下方展示链接指定的数据版本与清洗配方历史版本，原始采集记录另行展示。'
            : 'This panel shows the linked input version and historical cleaning recipe. Original collected records appear separately.',
          sourceSnapshot: zh ? '清洗输入版本' : 'Cleaning input version',
          cleaningVersion: zh ? '清洗配方版本' : 'Cleaning recipe version',
          cleaningStep: zh ? '步骤 {{step}}' : 'Step {{step}}',
          noCleaning: zh ? '未经过清洗' : 'No cleaning applied',
          parentResult: zh ? '父结果' : 'Parent result',
          resultState: zh ? '结果状态' : 'Result state',
          createdAt: zh ? '创建时间' : 'Created at',
          resultLink: zh ? '结果链接' : 'Result link',
          frozenParameters: zh ? '运行时的分析参数' : 'Parameters saved for this run',
          legacyProvenance: zh
            ? '历史结果未保存完整溯源信息。'
            : 'This legacy result has incomplete provenance.',
          branchTitle: zh ? '从此结果创建分支' : 'Branch from this result',
          branchHint: zh
            ? '沿用固定输入与分析方法，编辑参数后创建新结果，父结果保持不变。'
            : 'Keep this input and method, edit parameters and create a new result. The parent is preserved.',
          openBranch: zh ? '编辑分支参数' : 'Edit branch parameters',
          closeBranch: zh ? '收起分支参数' : 'Close branch parameters',
          runBranch: zh ? '运行新分支' : 'Run new branch',
          branchMethodUnavailable: zh
            ? '此结果使用的方法版本暂不可用，无法创建分支。'
            : 'This method version is unavailable, so a branch cannot run.',
          compareTitle: zh ? '比较分析结果' : 'Compare analysis results',
          compareHint: zh
            ? '比较相同输入、方法和字段的结果。参数或结构不兼容时会显示原因。'
            : 'Compare results with compatible inputs, methods and fields. Incompatible results show a reason.',
          compareSelect: zh ? '选择最近的结果' : 'Choose a recent result',
          compareId: zh ? '或输入结果 ID' : 'Or enter a result ID',
          compareRun: zh ? '开始比较' : 'Compare results',
          changedParameters: zh ? '变化的参数' : 'Changed parameters',
          sameParameters: zh ? '参数相同' : 'Parameters are identical',
          cleaningVersionUnavailable: zh
            ? '找不到此输入对应的清洗历史版本。'
            : 'The cleaning history version for this input is unavailable.',
          inputRows: zh ? '输入记录数' : 'Input rows',
          fingerprint: zh ? '版本指纹' : 'Version fingerprint',
          inputField: zh ? '字段' : 'Field',
          inputType: zh ? '类型' : 'Type',
          categories: zh
            ? {
                'data-quality': '数据质量',
                statistics: '数值统计',
                category: '分类比较',
                aggregation: '分组汇总',
                'time-series': '时间变化',
                text: '文本分析',
                'machine-learning': '机器学习',
              }
            : {
                'data-quality': 'Data quality',
                statistics: 'Statistics',
                category: 'Categories',
                aggregation: 'Aggregation',
                'time-series': 'Time series',
                text: 'Text',
                'machine-learning': 'Machine learning',
              },
          phase: zh
            ? {
                queued: '排队中',
                retrying: '等待自动重试',
                claimed: '准备执行',
                preparing: '准备数据',
                running: '计算中',
                persisting: '保存结果',
                succeeded: '已完成',
                failed: '失败',
                canceled: '已取消',
                canceling: '取消中',
                interrupted: '已中断',
                extracting: '提取数据',
                fetching: '加载页面',
                completed: '已完成',
                done: '已完成',
                created: '已创建',
                starting: '启动中',
                validating: '验证数据',
                waiting: '等待执行',
              }
            : {
                queued: 'Queued',
                retrying: 'Waiting to retry',
                claimed: 'Preparing to run',
                preparing: 'Preparing data',
                running: 'Computing',
                persisting: 'Saving results',
                succeeded: 'Completed',
                failed: 'Failed',
                canceled: 'Canceled',
                canceling: 'Canceling',
                interrupted: 'Interrupted',
                extracting: 'Extracting data',
                fetching: 'Loading page',
                completed: 'Completed',
                done: 'Completed',
                created: 'Created',
                starting: 'Starting',
                validating: 'Validating data',
                waiting: 'Waiting',
              },
          resultSummary: zh
            ? '已使用“{{method}}”完成 {{count}} 条记录的分析。'
            : 'Analyzed {{count}} records with {{method}}.',
          provenanceDetails: zh ? '技术与溯源详情' : 'Technical details and provenance',
          methods: nested,
          parameters: zh
            ? parameters
            : Object.fromEntries(Object.keys(parameters).map((k) => [k, humanize(k)])),
          options: zh
            ? options
            : Object.fromEntries(Object.keys(options).map((k) => [k, humanize(k)])),
          outputs: zh
            ? outputs
            : Object.fromEntries(Object.keys(outputs).map((k) => [k, humanize(k)])),
          noCompatibleFields: zh
            ? '此版本没有符合类型要求的字段，请选择其他版本或方法。'
            : 'This version has no compatible fields. Choose another version or method.',
          intent: zh
            ? {
                all: '完整算法目录',
                quality: '数据质量',
                comparison: '分类比较',
                time: '时间变化',
                anomaly: '异常发现',
              }
            : {
                all: 'All methods',
                quality: 'Data quality',
                comparison: 'Compare categories',
                time: 'Change over time',
                anomaly: 'Find anomalies',
              },
          datasetId: zh ? '数据集' : 'Dataset',
          snapshotId: zh ? '数据版本' : 'Data version',
          recipe: zh ? '分析方案' : 'Analysis recipe',
          job: zh ? '分析任务' : 'Analysis task',
        },
        ux: {
          change: zh
            ? { added: '新增', updated: '更新', removed: '删除' }
            : { added: 'Added', updated: 'Updated', removed: 'Removed' },
        },
      },
      true,
      true,
    );
  }
}
function humanize(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
}
