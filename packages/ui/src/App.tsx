import { Link, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import './styles.css';
import i18n from './i18n.js';
import { Button } from './components/ui.js';
import { TaskListPage } from './pages/TaskListPage.js';
import { TaskEditorPage } from './pages/TaskEditorPage.js';
import { TaskDetailPage } from './pages/TaskDetailPage.js';
import { RunDetailPage } from './pages/RunDetailPage.js';
import { DatasetPage } from './pages/DatasetPage.js';
import { OutputsPage } from './pages/OutputsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { PreferencesPage } from './pages/PreferencesPage.js';

export function App() {
  const { t } = useTranslation();
  const toggleLanguage = async () => {
    const next = i18n.language === 'en' ? 'zh-CN' : 'en';
    localStorage.setItem('zhiyun-language', next);
    await i18n.changeLanguage(next);
  };
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          <span className="brand-mark">织</span>
          <span>
            ZhiYun <small>织云</small>
          </span>
        </Link>
        <nav>
          <Link to="/">{t('tasks')}</Link>
          <Link to="/preferences">{t('preferencesAndTrends')}</Link>
          <Link to="/outputs">{t('outputs')}</Link>
          <Link to="/settings">{t('settings')}</Link>
          <Button className="button-ghost" onClick={() => void toggleLanguage()}>
            {t('language')}
          </Button>
        </nav>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<TaskListPage />} />
          <Route path="/tasks/new" element={<TaskEditorPage />} />
          <Route path="/tasks/:id/edit" element={<TaskEditorPage />} />
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
          <Route path="/tasks/:id/dataset" element={<DatasetPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/preferences" element={<PreferencesPage />} />
          <Route path="/outputs" element={<OutputsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <footer>{t('footer')}</footer>
    </div>
  );
}
