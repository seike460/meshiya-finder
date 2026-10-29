// esbuild entry for `npm run build:vendor`.
// Bundles the CommonJS `opening_hours` package (and its deps i18next / suncalc)
// into vendor/opening_hours.js as an ES module with a default export, so the
// static site can `import opening_hours from '../vendor/opening_hours.js'`
// without any CDN or runtime network access.
import opening_hours from 'opening_hours';

export default opening_hours;
