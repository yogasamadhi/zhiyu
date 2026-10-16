import { productCopy } from '@zhiyun/ui-sdk/product-copy';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Briefcase, TrendingUp, Pin, PinOff } from 'lucide-react';
import { Button, Card } from '@zhiyun/ui-sdk/components/ui';
import { useWorkspacePreference } from '@zhiyun/ui-sdk/workspace-preferences';
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
        {items.map((item) => {
          const pinned = pins.includes(item.path);
          const pinLabel = pinned
            ? `${zh ? '从侧边栏取消固定' : 'Unpin from sidebar'} ${item.title}`
            : `${zh ? '固定到侧边栏' : 'Pin to sidebar'} ${item.title}`;
          return (
            <Card key={item.path}>
              <div className="scenario-card-heading">
                <item.icon size={28} aria-hidden="true" />
                <Button
                  className="button-ghost icon-button"
                  aria-pressed={pinned}
                  aria-label={pinLabel}
                  title={pinLabel}
                  onClick={() =>
                    setPins(pinned ? pins.filter((p) => p !== item.path) : [...pins, item.path])
                  }
                >
                  {pinned ? <PinOff size={18} /> : <Pin size={18} />}
                </Button>
              </div>
              <h2>{item.title}</h2>
              <p>{item.description}</p>
              <div className="heading-actions">
                <Link className="button button-secondary" to={item.path}>
                  {zh ? '打开应用' : 'Open application'}
                </Link>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
