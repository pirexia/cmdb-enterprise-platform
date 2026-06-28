// Import all core reports — side-effect: each calls registerReport()
import './reports/inventory.js';
import './reports/obsolescence.js';
import './reports/security.js';
import './reports/contracts.js';
import './reports/licenses.js';
import './reports/compliance.js';
import './reports/lifecycle.js';
import './reports/auditTrail.js';
import './reports/impactMap.js';
import './reports/decommission.js';

export { createReportsRouter } from './router.js';
export { registerReport, unregisterPluginReports, getAvailableReports, getReport } from './registry.js';
export type * from './types.js';
