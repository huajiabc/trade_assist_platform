import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AccountProvider } from './accountContext';
import './styles.css';
import './tradingview.css';
import './workspace.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AccountProvider><App /></AccountProvider></React.StrictMode>,
);
