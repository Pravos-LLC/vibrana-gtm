import { prepareContentBuild, validateOverlay } from '../lib/content-overlay.mjs';
const result = process.argv.includes('--prepare') ? prepareContentBuild() : validateOverlay();
console.log(`Content mode validated: ${result.mode}`);
