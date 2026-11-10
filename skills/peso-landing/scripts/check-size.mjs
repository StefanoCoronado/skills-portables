#!/usr/bin/env node
// Suma el peso de los assets locales de una landing (HTML/CSS/JS/imágenes)
// y avisa si supera el presupuesto de 100 KB. Las fuentes de Google Fonts
// (cargadas por <link> externo) no cuentan porque no son un recurso propio.
//
// Uso: node check-size.mjs <carpeta-de-la-landing>

import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const BUDGET_BYTES = 100 * 1024;
const COUNTED_EXT = new Set(['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif']);

const target = process.argv[2];
if (!target) {
  console.error('Uso: node check-size.mjs <carpeta-de-la-landing>');
  process.exit(1);
}

function walk(dir) {
  let total = 0;
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && /^(node_modules|graphify-out|dist|build|[._].*)$/.test(entry.name)) continue;
    if (entry.isDirectory()) {
      const sub = walk(full);
      total += sub.total;
      files.push(...sub.files);
    } else if (COUNTED_EXT.has(extname(entry.name).toLowerCase())) {
      const size = statSync(full).size;
      total += size;
      files.push({ path: full, size });
    }
  }
  return { total, files };
}

const { total, files } = walk(target);
files.sort((a, b) => b.size - a.size);

console.log(`Peso total de assets locales: ${(total / 1024).toFixed(1)} KB (presupuesto: 100 KB)`);
console.log('');
for (const f of files) {
  console.log(`  ${(f.size / 1024).toFixed(1).padStart(8)} KB  ${f.path}`);
}
console.log('');

if (total > BUDGET_BYTES) {
  console.log(`⚠️  Supera el presupuesto por ${((total - BUDGET_BYTES) / 1024).toFixed(1)} KB.`);
  console.log('   Revisa primero el archivo más pesado de la lista de arriba (casi siempre una imagen sin redimensionar).');
  process.exit(2);
}

console.log('✓ Dentro del presupuesto.');
