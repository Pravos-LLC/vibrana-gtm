// Server/CLI-only operational data. Never import this module into client components.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentMode } from './content-overlay.mjs';
import { canonicalProduction, validateReleaseStamp } from './release-context.mjs';

const REPO = process.env.NEXT_RUNTIME ? process.cwd() : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sample = () => JSON.parse(readFileSync(resolve(REPO, 'config/runtime.sample.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fail() { throw new Error('Runtime configuration validation failed'); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, required = allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !(key in value))) fail();
}
function text(value, max = 5000) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(); }
function texts(value) { if (!Array.isArray(value) || value.length > 1000) fail(); value.forEach(item => text(item)); }
function url(value) { text(value, 2048); const parsed = new URL(value); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail(); }
function dictionary(value, validate) {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).length > 1000) fail();
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
    validate(item);
  }
}
function structural(value, template) {
  if (Array.isArray(template)) {
    if (!Array.isArray(value) || value.length > 1000) fail();
    if (template.length) for (const item of value) structural(item, template[0]);
  } else if (object(template)) {
    keys(value, Object.keys(template));
    for (const key of Object.keys(template)) structural(value[key], template[key]);
  } else if (typeof value !== typeof template || (typeof value === 'number' && !Number.isFinite(value))) fail();
}
export function validateRuntimeConfig(value) {
  try {
    keys(value, ['schemaVersion', 'calendar', 'publications', 'publicationChannels', 'offers', 'candidates', 'brand', 'mail', 'packaging']);
    if (value.schemaVersion !== 1) fail();
    keys(value.calendar, ['timezone', 'accounts', 'manual']); text(value.calendar.timezone, 100);
    new Intl.DateTimeFormat('en', { timeZone: value.calendar.timezone });
    dictionary(value.calendar.accounts, item => text(item, 128)); texts(value.calendar.manual);
    dictionary(value.publications, item => { keys(item, ['label', 'url']); text(item.label, 250); url(item.url); });
    dictionary(value.publicationChannels, item => { text(item, 128); if (!Object.hasOwn(value.publications, item)) fail(); });
    keys(value.brand, ['websiteUrl', 'authorLabel', 'podcastName', 'personalFrontDoorId']); url(value.brand.websiteUrl); text(value.brand.authorLabel, 250); text(value.brand.podcastName, 250); text(value.brand.personalFrontDoorId, 128);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(value.brand.personalFrontDoorId)) fail();
    keys(value.packaging, ['personalBrandId', 'profiles']); text(value.packaging.personalBrandId, 128);
    dictionary(value.packaging.profiles, profile => {
      keys(profile, ['name', 'defaultTheme', 'display', 'body', 'fonts', 'authority', 'voice', 'imagery', 'themes']);
      for (const key of ['name', 'display', 'body', 'authority', 'voice', 'imagery']) text(profile[key]);
      if (!['light', 'dark'].includes(profile.defaultTheme) || !Array.isArray(profile.fonts) || profile.fonts.length !== 2) fail();
      texts(profile.fonts);
      // Renderers read these names below a licensed-font root and interpolate font family names into CSS.
      if (profile.fonts.some(font => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.(woff2?|ttf|otf)$/.test(font))) fail();
      for (const key of ['display', 'body']) if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,127}$/.test(profile[key])) fail();
      keys(profile.themes, ['light', 'dark']);
      for (const theme of Object.values(profile.themes)) {
        keys(theme, ['bg', 'fg', 'muted', 'accent', 'positive']);
        for (const color of Object.values(theme)) if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) fail();
      }
    });
    if (!Object.hasOwn(value.packaging.profiles, value.packaging.personalBrandId)) fail();
    keys(value.mail, ['from', 'notify', 'engageFrom', 'outreachFrom', 'mailbox', 'trackFrom']);
    for (const key of ['from', 'notify', 'engageFrom', 'outreachFrom', 'mailbox']) { text(value.mail[key], 512); if (/[\r\n]/.test(value.mail[key])) fail(); }
    keys(value.mail.trackFrom, ['client', 'guest']); for (const item of Object.values(value.mail.trackFrom)) { text(item, 512); if (/[\r\n]/.test(item)) fail(); }
    const template = sample();
    structural(value.candidates, template.candidates);
    keys(value.offers, ['version', 'reviewed_at', 'offers']);
    if (value.offers.version !== 1 || !Number.isFinite(Date.parse(value.offers.reviewed_at)) || !Array.isArray(value.offers.offers) || !value.offers.offers.length || value.offers.offers.length > 100) fail();
    const examples = template.offers.offers;
    const allowed = [...new Set(examples.flatMap(item => Object.keys(item)))];
    const required = allowed.filter(key => examples.every(item => key in item));
    for (const offer of value.offers.offers) {
      keys(offer, allowed, required);
      for (const key of ['id', 'name', 'purpose', 'scope', 'price', 'owner', 'reviewed_at', 'commercial_source']) text(offer[key]);
      for (const key of ['deliverables', 'inputs', 'fits', 'poor_fit', 'prohibited', 'sources']) texts(offer[key]);
      // Sources are provenance citations and may be document references, not navigation URLs.
      dictionary(offer.claims, item => text(item)); url(offer.url);
      if (typeof offer.active !== 'boolean') fail();
      if ('not_to_be_confused_with' in offer) text(offer.not_to_be_confused_with);
    }
    return value;
  } catch { fail(); }
}
export function readPrivateRuntimeConfig(root, env = process.env) {
  try {
    if (!isAbsolute(root) || lstatSync(root).isSymbolicLink()) fail();
    const actual = realpathSync(root), file = resolve(actual, 'runtime.json');
    const rel = relative(realpathSync(REPO), actual);
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) fail();
    if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile() || statSync(file).size > 1024 * 1024) fail();
    const bytes = readFileSync(file);
    if (!/^[a-f0-9]{64}$/.test(env.PRIVATE_RUNTIME_DIGEST ?? '') || hash(bytes) !== env.PRIVATE_RUNTIME_DIGEST) fail();
    return { config: validateRuntimeConfig(JSON.parse(bytes.toString('utf8'))), bytes };
  } catch { fail(); }
}
export function loadRuntimeConfig(env = process.env) {
  if (typeof window !== 'undefined') fail();
  if (contentMode(env) === 'sample') return validateRuntimeConfig(sample());
  const supplied = env.PRIVATE_OVERLAY_ROOT;
  if (canonicalProduction(env)) validateReleaseStamp(REPO, env);
  if (supplied && existsSync(supplied)) return readPrivateRuntimeConfig(supplied, env).config;
  const root = resolve(REPO, '.content-runtime');
  try {
    const file = resolve(root, 'runtime.json');
    if (lstatSync(root).isSymbolicLink() || lstatSync(file).isSymbolicLink() || statSync(file).size > 1024 * 1024) fail();
    const bytes = readFileSync(file);
    if (!/^[a-f0-9]{64}$/.test(env.PRIVATE_RUNTIME_DIGEST ?? '') || hash(bytes) !== env.PRIVATE_RUNTIME_DIGEST) fail();
    return validateRuntimeConfig(JSON.parse(bytes.toString('utf8')));
  } catch { fail(); }
}
