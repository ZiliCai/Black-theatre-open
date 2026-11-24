import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/tokens.css';
import './theme/base.css';
import { ToastHost } from './components';
import { DialogHost } from './components/dialog';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastHost>
      <DialogHost>
        <App />
      </DialogHost>
    </ToastHost>
  </StrictMode>,
);
