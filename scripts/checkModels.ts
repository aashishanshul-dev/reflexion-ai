/**
 * Lists the Gemini models your GEMINI_API_KEY can use for text generation.
 * Usage: npm run models:check
 *
 * The key is read from the environment (or .env via dotenv) and is never printed.
 */
import dotenv from 'dotenv';
import { ALL_MODEL_IDS } from '../src/lib/modelConfig';

dotenv.config({ quiet: true });

const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
if (!apiKey.trim() || apiKey === 'MY_GEMINI_API_KEY') {
  console.error('GEMINI_API_KEY is not set. Add it to your environment or .env file.');
  process.exit(1);
}

// The bundled @google/genai package only implements generateContent, so call
// the official REST list endpoint directly. The key goes in a header, not the URL.
interface ApiModel {
  name?: string;
  supportedGenerationMethods?: string[];
}

const available: string[] = [];
try {
  let pageToken = '';
  do {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { models?: ApiModel[]; nextPageToken?: string };
    for (const m of data.models ?? []) {
      if (!(m.supportedGenerationMethods ?? []).includes('generateContent')) continue;
      const id = (m.name ?? '').replace(/^models\//, '');
      if (id.startsWith('gemini')) available.push(id);
    }
    pageToken = data.nextPageToken ?? '';
  } while (pageToken);
} catch (err) {
  console.error('Could not list models:', err instanceof Error ? err.message : err);
  process.exit(1);
}

available.sort();
console.log(`Gemini models your key can use for generateContent (${available.length}):`);
for (const id of available) console.log(`  ${id}`);

console.log('\nModels configured in src/lib/modelConfig.ts:');
let missing = 0;
for (const id of ALL_MODEL_IDS) {
  const ok = available.includes(id);
  if (!ok) missing++;
  console.log(`  ${ok ? 'OK     ' : 'MISSING'} ${id}`);
}
if (missing) {
  console.error(`\n${missing} configured model(s) are not available to this key.`);
  process.exit(2);
}
