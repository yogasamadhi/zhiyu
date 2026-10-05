import './globals.css';
import type { Metadata } from 'next';
export const metadata: Metadata = {
  title: '织云 · 本地数据工作台',
  description: '采集与分析留在本地，自带 Key 免费使用 AI，按需订阅托管 AI。',
};
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
