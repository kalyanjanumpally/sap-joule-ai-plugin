const cds = require('@sap/cds');
const { activate } = require('./lib/cdsPlugin');

// Attach the plugin handle to `cds` so app code can call `cds.vectorHana.searchByMeaning(...)`
// without importing this package directly (the same ergonomic pattern @sap/cds uses for
// mtx, auth, and audit-log plugins).
cds.vectorHana = activate(cds);

cds.on('loaded', () => {
  cds.log('vector-hana').info('cds-plugin-vector-hana registered: @rag annotation active');
});
