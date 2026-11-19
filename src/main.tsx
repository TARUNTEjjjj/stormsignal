import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { reportCaughtError } from './components/OptionalPanel';
import { startMotion } from './motion';
import './styles.css';
import './frontend-design.css';

window.appUpdateCanReload = () => false;

// An optional tool that failed to download is explained on the page: a warning in the console.
createRoot(document.getElementById('root')!, { onCaughtError: reportCaughtError }).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
// Section reveals and card tilt; nothing under reduced motion (see motion.ts).
startMotion();
