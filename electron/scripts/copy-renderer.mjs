import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

const src = path.join(root, 'client', 'dist');
const dest = path.join(root, 'electron', 'dist', 'renderer');

if (!fs.existsSync(src)) {
    console.error(`[Build] Client dist directory not found: ${src}`);
    process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[Build] Renderer assets copied from ${src} to ${dest}`);
