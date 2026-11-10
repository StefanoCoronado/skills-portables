#!/usr/bin/env node
// Fotografía del flujo de trabajo de un proyecto: lenguajes, dependencias, agentes y actividad.
// Solo lectura. No abre archivos .env y de la configuración MCP extrae únicamente nombres.
//
// Uso: node perfil.mjs <carpeta-del-proyecto> [--global]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const raiz = args.find((a) => !a.startsWith('--'));
if (!raiz || !existsSync(raiz) || !statSync(raiz).isDirectory()) {
  console.error('Uso: node perfil.mjs <carpeta-del-proyecto> [--global]');
  process.exit(1);
}

const IGNORAR = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', '.venv', 'venv', '__pycache__', 'graphify-out', 'target', 'vendor', '.vercel', 'coverage']);
const LIMITE = 20000;
const git = (...a) => {
  try { return execFileSync('git', ['-C', raiz, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }); }
  catch { return null; }
};

let rutas = git('ls-files', '--cached', '--others', '--exclude-standard')?.split('\n').filter(Boolean);
if (!rutas) {
  rutas = [];
  (function recorrer(dir, prefijo) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (rutas.length >= LIMITE) return;
      if (e.isDirectory()) { if (!IGNORAR.has(e.name)) recorrer(join(dir, e.name), `${prefijo}${e.name}/`); }
      else rutas.push(`${prefijo}${e.name}`);
    }
  })(raiz, '');
}
const recortado = rutas.length > LIMITE;
rutas = rutas.slice(0, LIMITE).filter((r) => !r.split('/').some((p) => IGNORAR.has(p)));

const extensiones = {};
for (const r of rutas) {
  const e = extname(r).toLowerCase();
  if (e) extensiones[e] = (extensiones[e] || 0) + 1;
}
const topExtensiones = Object.entries(extensiones).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([ext, archivos]) => ({ ext, archivos }));

const leer = (r) => { try { return readFileSync(join(raiz, r), 'utf8'); } catch { return null; } };
const json = (r) => { try { return JSON.parse(leer(r)); } catch { return null; } };
const tokensAprox = (texto) => Math.round(texto.length / 4);

const dependencias = {};
const pkg = json('package.json');
if (pkg) {
  dependencias.npm = Object.keys(pkg.dependencies || {});
  dependencias.npmDev = Object.keys(pkg.devDependencies || {});
  dependencias.scriptsNpm = Object.keys(pkg.scripts || {});
}
for (const [archivo, clave] of [['requirements.txt', 'python'], ['pyproject.toml', 'python'], ['go.mod', 'go'], ['Cargo.toml', 'rust'], ['composer.json', 'php'], ['Gemfile', 'ruby']]) {
  if (existsSync(join(raiz, archivo))) dependencias[clave] = archivo;
}

const instrucciones = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', '.github/copilot-instructions.md']
  .filter((f) => existsSync(join(raiz, f)))
  .map((f) => ({ archivo: f, tokensAprox: tokensAprox(leer(f) || '') }));

const subcarpetas = (d) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); } catch { return []; } };
const archivosDe = (d) => { try { return readdirSync(d).filter((f) => /\.(md|mdc|toml)$/.test(f)).map((f) => basename(f).replace(/\.\w+$/, '')); } catch { return []; } };

function agentes(base) {
  return {
    skills: [...new Set([...subcarpetas(join(base, '.claude/skills')), ...subcarpetas(join(base, '.agents/skills')), ...subcarpetas(join(base, '.codex/skills'))])],
    subagentes: archivosDe(join(base, '.claude/agents')),
    comandos: archivosDe(join(base, '.claude/commands')),
    reglasCursor: archivosDe(join(base, '.cursor/rules')),
  };
}

function ajustes(base) {
  const salida = { hooks: [], plugins: [], servidoresMcp: [] };
  for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.claude.json']) {
    let d;
    try { d = JSON.parse(readFileSync(join(base, f), 'utf8')); } catch { continue; }
    salida.hooks.push(...Object.keys(d.hooks || {}));
    salida.plugins.push(...Object.keys(d.enabledPlugins || {}));
    salida.servidoresMcp.push(...Object.keys(d.mcpServers || {}));
  }
  try { salida.servidoresMcp.push(...Object.keys(JSON.parse(readFileSync(join(base, '.mcp.json'), 'utf8')).mcpServers || {})); } catch { /* sin .mcp.json */ }
  for (const k of Object.keys(salida)) salida[k] = [...new Set(salida[k])];
  return salida;
}

let actividad = null;
const registro = git('log', '--since=90.days', '--name-only', '--pretty=format:@@%s');
if (registro !== null) {
  const tipos = {}, carpetas = {};
  let commits = 0;
  for (const linea of registro.split('\n')) {
    if (linea.startsWith('@@')) {
      commits++;
      const t = linea.slice(2).match(/^(\w+)(\(.*\))?!?:/)?.[1];
      if (t) tipos[t] = (tipos[t] || 0) + 1;
    } else if (linea.trim()) {
      const c = linea.split('/').slice(0, 2).join('/');
      carpetas[c] = (carpetas[c] || 0) + 1;
    }
  }
  const orden = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([nombre, veces]) => ({ nombre, veces }));
  actividad = { commits90dias: commits, tiposDeCommit: orden(tipos, 8), carpetasMasTocadas: orden(carpetas, 10) };
}

const perfil = {
  proyecto: basename(raiz),
  archivos: rutas.length,
  recortado,
  lenguajes: topExtensiones,
  dependencias,
  instrucciones,
  agentes: agentes(raiz),
  ajustes: ajustes(raiz),
  actividad,
};
if (args.includes('--global')) perfil.global = { agentes: agentes(homedir()), ajustes: ajustes(homedir()) };

console.log(JSON.stringify(perfil, null, 2));
