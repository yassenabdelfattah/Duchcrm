import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { missingConfig } from './lib/supabase';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('No #root element in index.html');

const root = createRoot(container);

if (missingConfig.length > 0) {
  // Deliberately plain, and bilingual, and not a React error boundary: the
  // whole point is that it renders when the app cannot be configured at all.
  // A deploy missing these variables otherwise serves a white page whose only
  // explanation is a line in the browser console - which means the first
  // person to see it is a staff member reporting that the app is broken.
  root.render(
    <div
      dir="rtl"
      style={{
        fontFamily: 'Cairo, system-ui, sans-serif',
        maxWidth: '32rem',
        margin: '4rem auto',
        padding: '0 1rem',
        lineHeight: 1.7,
      }}
    >
      <h1 style={{ fontSize: '1.25rem', fontWeight: 800 }}>
        التطبيق غير مهيأ
        <span style={{ display: 'block', fontSize: '0.9rem', fontWeight: 400, color: '#78716c' }}>
          The app is not configured
        </span>
      </h1>

      <p style={{ color: '#44403c' }}>
        هذه مشكلة في الإعداد وليست عطلاً — أبلغ المسؤول. إعادة التحميل لن تساعد.
        <span style={{ display: 'block', color: '#78716c' }}>
          This is a setup problem, not a fault. Reloading will not help.
        </span>
      </p>

      <p style={{ color: '#44403c', marginTop: '1.5rem' }}>
        Missing at build time:
        <code
          style={{
            display: 'block',
            direction: 'ltr',
            textAlign: 'left',
            background: '#f5f5f4',
            padding: '0.75rem',
            marginTop: '0.5rem',
            borderRadius: '0.5rem',
            fontSize: '0.85rem',
          }}
        >
          {missingConfig.join('\n')}
        </code>
      </p>

      <p style={{ color: '#78716c', fontSize: '0.85rem', direction: 'ltr', textAlign: 'left' }}>
        These are baked in when the site is built, so they must be set as{' '}
        <strong>build</strong> variables — runtime Worker variables never reach
        the build. In Cloudflare: Settings → Build → Build Variables and Secrets.
      </p>
    </div>,
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
