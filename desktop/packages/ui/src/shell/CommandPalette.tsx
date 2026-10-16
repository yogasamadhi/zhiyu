import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { runtimeClient } from '@zhiyun/client';
import { Dialog } from '@zhiyun/ui-sdk/components/experience';

export interface PaletteDestination {
  to: string;
  label: string;
}

interface PaletteItem {
  key: string;
  to: string;
  label: string;
  group: string;
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** ⌘/Ctrl+K searches tasks, datasets, corpora and pages; ⌘/Ctrl+N starts a task; ? lists shortcuts. */
export function CommandPalette({
  destinations,
  canCreateTasks,
  zh,
}: {
  destinations: PaletteDestination[];
  canCreateTasks: boolean;
  zh: boolean;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const text = (cn: string, en: string) => (zh ? cn : en);

  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setHelp(false);
        setOpen((value) => !value);
      } else if (
        command &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'n' &&
        canCreateTasks
      ) {
        event.preventDefault();
        setOpen(false);
        void navigate('/tasks/new');
      } else if (event.key === '?' && !command && !isEditable(event.target)) {
        event.preventDefault();
        setOpen(false);
        setHelp(true);
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [canCreateTasks, navigate]);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    // showModal() focuses the first control, so move focus to the search box afterwards.
    if (open) {
      input.current?.focus();
      return;
    }
    setQuery('');
    setTerm('');
    setActive(0);
  }, [open]);

  const results = useQuery({
    queryKey: ['command-palette', term, zh],
    enabled: open && term.length > 0,
    retry: false,
    queryFn: async () => {
      const [tasks, datasets, corpora] = await Promise.allSettled([
        runtimeClient.listTasks(8, undefined, { query: term }),
        runtimeClient.listDatasets(8, undefined, undefined, { query: term }),
        runtimeClient.listCorpora(100),
      ]);
      const lower = term.toLowerCase();
      return [
        ...(tasks.status === 'fulfilled' ? tasks.value.items : []).map((task) => ({
          key: `task-${task.id}`,
          to: `/tasks/${task.id}`,
          label: task.name,
          group: text('采集任务', 'Tasks'),
        })),
        ...(datasets.status === 'fulfilled' ? datasets.value.items : [])
          .filter((dataset) => dataset.name)
          .map((dataset) => ({
            key: `dataset-${dataset.id}`,
            to: `/datasets/${dataset.id}`,
            label: dataset.name!,
            group: text('数据集', 'Datasets'),
          })),
        ...(corpora.status === 'fulfilled' ? corpora.value.items : [])
          .filter((corpus) => corpus.name.toLowerCase().includes(lower))
          .slice(0, 8)
          .map((corpus) => ({
            key: `corpus-${corpus.id}`,
            to: `/corpora/${corpus.id}`,
            label: corpus.name,
            group: text('语料', 'Corpora'),
          })),
      ];
    },
  });

  const items: PaletteItem[] = (() => {
    const lower = term.toLowerCase();
    const pages = [
      ...(canCreateTasks ? [{ to: '/tasks/new', label: text('新建采集任务', 'New task') }] : []),
      ...destinations,
    ]
      .filter((page) => !lower || page.label.toLowerCase().includes(lower))
      .map((page) => ({
        key: `page-${page.to}`,
        to: page.to,
        label: page.label,
        group: text('页面', 'Pages'),
      }));
    return [...pages, ...(results.data ?? [])];
  })();

  const go = (item: PaletteItem | undefined) => {
    if (!item) return;
    setOpen(false);
    void navigate(item.to);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => (items.length ? (index + step + items.length) % items.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(items[active]);
    }
  };
  const activeItem = items[active];

  return (
    <>
      <Dialog
        open={open}
        title={text('搜索与跳转', 'Search and go')}
        onClose={() => setOpen(false)}
      >
        <div className="command-palette">
          <input
            ref={input}
            className="input"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeItem ? `${listId}-${activeItem.key}` : undefined}
            aria-label={text(
              '搜索任务、数据集、语料或页面',
              'Search tasks, datasets, corpora or pages',
            )}
            placeholder={text(
              '搜索任务、数据集、语料或页面…',
              'Search tasks, datasets, corpora or pages…',
            )}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <ul id={listId} role="listbox" aria-label={text('搜索结果', 'Results')}>
            {items.map((item, index) => (
              <li
                key={item.key}
                id={`${listId}-${item.key}`}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(item)}
              >
                <span>{item.label}</span>
                <small>{item.group}</small>
              </li>
            ))}
          </ul>
          {term && results.isFetching && (
            <p className="muted" role="status">
              {text('正在搜索…', 'Searching…')}
            </p>
          )}
          {term && !results.isFetching && items.length === 0 && (
            <p className="muted" role="status">
              {text('没有匹配的结果。', 'No matches.')}
            </p>
          )}
        </div>
      </Dialog>
      <Dialog
        open={help}
        title={text('键盘快捷键', 'Keyboard shortcuts')}
        onClose={() => setHelp(false)}
      >
        <dl className="shortcut-list">
          <div>
            <dt>
              <kbd>⌘/Ctrl</kbd> <kbd>K</kbd>
            </dt>
            <dd>{text('搜索与跳转', 'Search and go')}</dd>
          </div>
          {canCreateTasks && (
            <div>
              <dt>
                <kbd>⌘/Ctrl</kbd> <kbd>N</kbd>
              </dt>
              <dd>{text('新建采集任务', 'New task')}</dd>
            </div>
          )}
          <div>
            <dt>
              <kbd>?</kbd>
            </dt>
            <dd>{text('显示快捷键', 'Show shortcuts')}</dd>
          </div>
          <div>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>{text('关闭对话框', 'Close dialog')}</dd>
          </div>
        </dl>
      </Dialog>
    </>
  );
}
