declare global {
  interface Window {
    zhiyunCredential: { kind: string; submit(value: string): void; cancel(): void };
  }
}

export {};

const form = document.querySelector<HTMLFormElement>('#credential-form')!;
const input = document.querySelector<HTMLTextAreaElement>('#credential-value')!;
const label = document.querySelector<HTMLElement>('#credential-label')!;
const examples: Record<string, { label: string; placeholder: string }> = {
  'ai-api-key': {
    label: 'AI Provider API Key',
    placeholder: '输入 API Key（只会加密保存到本机）',
  },
  'task-secret-headers': {
    label: '敏感 Headers（JSON）',
    placeholder: '{\n  "Authorization": "Bearer …"\n}',
  },
  'task-cookies': {
    label: 'Cookies（JSON）',
    placeholder: '[\n  {"name":"session","value":"…","path":"/"}\n]',
  },
  'task-proxy': {
    label: '代理（JSON）',
    placeholder: '{\n  "url":"http://proxy:8080",\n  "username":"…",\n  "password":"…"\n}',
  },
  'output-webhook': {
    label: 'Webhook HMAC Secret',
    placeholder: '输入至少 32 字节的随机 Secret',
  },
  'output-postgres': {
    label: 'PostgreSQL Connection String',
    placeholder: 'postgresql://user:password@host:5432/database',
  },
};
const display = examples[window.zhiyunCredential.kind] ?? {
  label: '凭据值',
  placeholder: '',
};
label.textContent = display.label;
input.placeholder = display.placeholder;
if (
  window.zhiyunCredential.kind.startsWith('output-') ||
  window.zhiyunCredential.kind === 'ai-api-key'
) {
  input.style.setProperty('-webkit-text-security', 'disc');
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  window.zhiyunCredential.submit(input.value);
  input.value = '';
});
document
  .querySelector('#cancel')!
  .addEventListener('click', () => window.zhiyunCredential.cancel());
