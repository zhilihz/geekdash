import './shared/detail.css';
import './shared/read.css';
import { setupTheme, requireIdentity } from './shared/api';
setupTheme();
void requireIdentity().catch(() => {});
