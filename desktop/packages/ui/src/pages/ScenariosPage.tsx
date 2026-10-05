import { productCopy } from '../product-copy.js';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Briefcase, TrendingUp, BookOpen, Pin } from 'lucide-react';
import { Button, Card } from '../components/ui.js';
import { useWorkspacePreference } from '../workspace-preferences.js';
export function ScenariosPage() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [pins, setPins] = useWorkspacePreference<string[]>('pinned-navigation', []);
  const items = [
    {
      path: '/recruitment',
      icon: Briefcase,
      title: zh ? productCopy('职位雷达') : 'Job radar',
      description: zh
        ? '导入职位、查看匹配结果，管理关注与跟进。'
        : 'Import jobs, discover matches and track follow-ups.',
    },
    {
      path: '/preferences',
      icon: TrendingUp,
      title: zh ? '内容趋势' : 'Content trends',
      description: zh
        ? '关注主题，查看热点与内容变化。'
        : 'Follow topics and explore changing content trends.',
    },
    {
      path: '/corpora',
      icon: BookOpen,
      title: zh ? '语料工作台' : 'Corpus workbench',
      description: zh
        ? '将文本数据清洗、分块并导出为语料。'
        : 'Clean, chunk and export text datasets.',
    },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{zh ? '场景应用' : 'Applications'}</h1>
          <p>
            {zh
              ? '围绕具体目标使用你的数据，固定常用入口。'
              : 'Use your data for a specific goal and pin your frequent tools.'}
          </p>
        </div>
      </div>
      <div className="scenario-grid">
        {items.map((item) => (
          <Card key={item.path}>
            <item.icon size={28} />
            <h2>{item.title}</h2>
            <p>{item.description}</p>
            <div className="heading-actions">
              <Link className="button button-secondary" to={item.path}>
                {zh ? '打开应用' : 'Open application'}
              </Link>
              <Button
                className="button-ghost"
                aria-pressed={pins.includes(item.path)}
                aria-label={`${zh ? '固定' : 'Pin'} ${item.title}`}
                onClick={() =>
                  setPins(
                    pins.includes(item.path)
                      ? pins.filter((p) => p !== item.path)
                      : [...pins, item.path],
                  )
                }
              >
                <Pin size={18} />
                {pins.includes(item.path) ? (zh ? '已固定' : 'Pinned') : zh ? '固定' : 'Pin'}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
