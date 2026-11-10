#!/usr/bin/env node
// Radiografía estática de un plugin, skill, servidor MCP o repositorio ANTES de instalarlo.
// Solo lee texto. Nunca ejecuta, instala ni importa nada de la carpeta analizada.
//
// Uso: node radiografia.mjs <carpeta-objetivo>
// Salida: 0 sin señales críticas · 2 con señales críticas · 1 error de uso

import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, extname, relative, sep, basename } from 'node:path';

const raiz = process.argv[2];
if (!raiz || !existsSync(raiz) || !statSync(raiz).isDirectory()) {
  console.error('Uso: node radiografia.mjs <carpeta-objetivo>');
  process.exit(1);
}

const IGNORAR = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'graphify-out']);
const TEXTO = new Set(['.md', '.mdc', '.txt', '.json', '.yml', '.yaml', '.toml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.rb', '.go', '.rs', '.php', '.html', '.css']);
const EJECUTABLE = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.rb', '.php']);
const BINARIO = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.node', '.wasm', '.jar', '.msi', '.deb', '.pkg', '.dmg', '.app']);
const MAX_BYTES = 1024 * 1024;

const rel = (r) => relative(raiz, r).split(sep).join('/');
const archivos = [];
const enlaces = [];
(function recorrer(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, e.name);
    if (lstatSync(ruta).isSymbolicLink()) { enlaces.push(rel(ruta)); continue; }
    if (e.isDirectory()) { if (!IGNORAR.has(e.name)) recorrer(ruta); continue; }
    archivos.push({ ruta, r: rel(ruta), ext: extname(e.name).toLowerCase(), nombre: e.name, bytes: statSync(ruta).size });
  }
})(raiz);

const leer = (a) => { try { return readFileSync(a.ruta, 'utf8'); } catch { return ''; } };
const buscar = (n) => archivos.filter((a) => a.nombre === n);
const tokensAprox = (t) => Math.round(t.length / 4);
const json = (a) => { try { return JSON.parse(leer(a)); } catch { return null; } };

const señales = [];
const señal = (nivel, tipo, archivo, linea, detalle) => señales.push({ nivel, tipo, archivo, linea, detalle });

// Tipos de contenido
const skillsMd = buscar('SKILL.md');
const plugins = archivos.filter((a) => a.r.endsWith('.claude-plugin/plugin.json') || a.nombre === 'plugin.json');
const marketplaces = archivos.filter((a) => a.nombre === 'marketplace.json');
const paquetes = buscar('package.json');
const mcp = buscar('.mcp.json');
const hooksJson = archivos.filter((a) => a.nombre === 'hooks.json' || /(^|\/)hooks\//.test(a.r));
const agentes = archivos.filter((a) => /(^|\/)agents\/[^/]+\.md$/.test(a.r));
const comandos = archivos.filter((a) => /(^|\/)commands\/[^/]+\.md$/.test(a.r));

const tipos = [];
if (marketplaces.length) tipos.push('marketplace');
if (plugins.length) tipos.push('plugin');
if (skillsMd.length) tipos.push('skill');
if (mcp.length) tipos.push('servidor-mcp');
if (paquetes.length) tipos.push('paquete-npm');
if (!tipos.length) tipos.push('repositorio');

// Costo de contexto: lo que se carga siempre y lo que se carga al activarse.
function frontmatter(texto) {
  const m = texto.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { nombre: null, descripcion: '' };
  const bloque = `\n${m[1].replace(/\r/g, '')}`;
  const nombre = bloque.match(/\nname:\s*(.+)/)?.[1]?.trim() ?? null;
  // Sin bandera m: $ debe ser el final del bloque para aceptar descripciones de varias líneas (description: |).
  const descripcion = bloque.match(/\ndescription:\s*([\s\S]*?)(?=\n[\w-]+:|\s*$)/)?.[1]?.replace(/^[|>][+-]?\s*/, '').trim() ?? '';
  return { nombre, descripcion };
}
const costoSkills = skillsMd.map((a) => {
  const t = leer(a);
  const f = frontmatter(t);
  return { archivo: a.r, nombre: f.nombre, tokensSiempre: tokensAprox(f.descripcion), tokensAlActivar: tokensAprox(t) };
});
const costoAgentes = [...agentes, ...comandos].map((a) => tokensAprox(frontmatter(leer(a)).descripcion)).reduce((x, y) => x + y, 0);

// Patrones de riesgo. Cada uno describe lo que hace la línea, no si es malicioso.
const PATRONES = [
  ['critica', 'descarga-y-ejecuta', /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\biex\b.*\b(iwr|Invoke-WebRequest|DownloadString)\b/i, 'Descarga código de internet y lo ejecuta sin revisión.'],
  ['critica', 'lee-credenciales-navegador', /Login Data|Cookies\.binarysqlite|browser_cookie|chrome_cookies|\bcookies\.sqlite\b|Local State.*encrypted_key|Safari\/Cookies/i, 'Accede a cookies o contraseñas guardadas en el navegador.'],
  ['critica', 'lee-claves-sistema', /[~$\w/\\.]*\.ssh[/\\](id_|authorized)|\.aws[/\\]credentials|\bsecurity\s+find-generic-password\b|\bkeychain\b.*\bdump\b/i, 'Lee claves SSH, credenciales de nube o el llavero del sistema.'],
  ['alta', 'lee-env', /(open|readFile\w*|load_dotenv|cat|Get-Content|source)\b[^\n]{0,40}\.env\b/i, 'Lee variables de entorno de un archivo .env.'],
  ['alta', 'ejecuta-texto', /(?<![\w.])eval\s*\(|new\s+Function\s*\(|\bexec\s*\(\s*(compile|base64|requests)|base64\s+(-d|--decode)\s*\|/i, 'Ejecuta texto como código, lo que dificulta auditarlo.'],
  ['alta', 'destructivo', /\brm\s+-[a-z]*r[a-z]*f\b|\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force|\bgit\s+push\s+[^\n]*--force\b|\bgit\s+reset\s+--hard\b|\bDROP\s+(TABLE|DATABASE)\b/i, 'Puede borrar o sobrescribir datos sin vuelta atrás.'],
  ['alta', 'salta-permisos', /--dangerously-skip-permissions|--no-verify\b|dangerouslyDisableSandbox|bypassPermissions/i, 'Desactiva protecciones del agente o de git.'],
  ['media', 'red-saliente', /\b(curl|wget)\s+[^\n]*https?:|\bfetch\s*\(\s*["'`]https?:|\brequests\.(get|post|put)\s*\(|\burllib\.request\b|\baxios\.(get|post)\s*\(|Invoke-WebRequest/i, 'Se conecta a internet.'],
  ['media', 'proceso-externo', /\bsubprocess\.(run|Popen|call|check_output)\b|\bchild_process\b|\bexecSync\s*\(|\bspawn(Sync)?\s*\(|\bos\.system\s*\(/, 'Lanza programas externos.'],
  ['media', 'descarga-paquetes', /\b(npx|uvx|pipx\s+run|bunx)\s+[@\w]|\bpip3?\s+install\b|\bnpm\s+i(nstall)?\s+-g\b/i, 'Instala o ejecuta paquetes en el momento de usarla.'],
];
const INYECCION = [
  [/ignore (all )?(previous|prior|above) (instructions|prompts)|ignora (todas )?las instrucciones (anteriores|previas)/i, 'Intenta anular las instrucciones del agente.'],
  [/(do not|don't|never) (tell|inform|mention|reveal)[^.\n]{0,40}\b(user|human)\b|no (le )?(digas|menciones|informes)[^.\n]{0,40}\busuario\b/i, 'Pide ocultarle algo al usuario.'],
  [/(send|post|upload|exfiltrate)[^.\n]{0,60}(api[_ -]?key|token|password|secret|credential)/i, 'Pide enviar secretos a otro lugar.'],
];
const PROMO = /(recommend|promote|mention)[^.\n]{0,50}\b(our|my)\s+(product|service|platform|paid)|(recomienda|promociona|menciona)[^.\n]{0,50}\b(nuestro|mi)\s+(producto|servicio|plataforma)/i;

for (const a of archivos) {
  if (BINARIO.has(a.ext)) señal('alta', 'binario', a.r, 0, `Ejecutable compilado de ${(a.bytes / 1024).toFixed(0)} KB que no se puede leer.`);
  if (!TEXTO.has(a.ext) && !/^\.?[\w-]+$/.test(a.nombre)) continue;
  if (a.bytes > MAX_BYTES) continue;
  const texto = leer(a);
  if (texto.includes('\u0000')) continue;
  const esDoc = ['.md', '.mdc', '.txt'].includes(a.ext);
  const esEjecutable = EJECUTABLE.has(a.ext);
  texto.split(/\r?\n/).forEach((linea, i) => {
    if (linea.length > 2000) {
      if (esEjecutable) señal('alta', 'codigo-ofuscado', a.r, i + 1, `Línea de ${linea.length} caracteres: código minificado u ofuscado.`);
      return;
    }
    for (const [nivel, tipo, re, detalle] of PATRONES) {
      if (!re.test(linea)) continue;
      // En documentación un patrón suele ser un ejemplo: baja a «doc» salvo el de descargar y ejecutar.
      const final = esDoc && tipo !== 'descarga-y-ejecuta' ? 'doc' : nivel;
      señal(final, tipo, a.r, i + 1, detalle);
    }
    if (esDoc || a.ext === '.json' || a.ext === '.yaml' || a.ext === '.yml') {
      for (const [re, detalle] of INYECCION) if (re.test(linea)) señal('critica', 'instruccion-sospechosa', a.r, i + 1, detalle);
      if (PROMO.test(linea)) señal('media', 'promocion', a.r, i + 1, 'Instruye al agente a promocionar un producto.');
    }
    if (/[A-Za-z0-9+/]{300,}={0,2}/.test(linea) && esEjecutable) señal('alta', 'bloque-base64', a.r, i + 1, 'Bloque codificado largo dentro del código.');
  });
}

// Instalación y arranque automático
for (const p of paquetes) {
  const d = json(p);
  for (const fase of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (d?.scripts?.[fase]) señal(fase === 'prepare' ? 'media' : 'critica', 'script-de-instalacion', p.r, 0, `«${fase}» corre solo al instalar: ${String(d.scripts[fase]).slice(0, 80)}`);
  }
}
for (const h of hooksJson.filter((a) => a.ext === '.json')) {
  const eventos = Object.keys(json(h)?.hooks || {});
  if (eventos.length) señal('alta', 'hook-automatico', h.r, 0, `Corre comandos sin que los pidas en: ${eventos.join(', ')}.`);
}
for (const m of mcp) {
  for (const [nombre, s] of Object.entries(json(m)?.mcpServers || {})) {
    señal('media', 'servidor-mcp', m.r, 0, `Agrega el servidor «${nombre}» (${s.command || s.url || s.type || 'sin detalle'}).`);
  }
}
if (enlaces.length) señal('media', 'enlace-simbolico', enlaces[0], 0, `${enlaces.length} enlaces simbólicos no se siguieron y no quedaron analizados.`);

// Metadatos
const licencia = archivos.find((a) => /^(licen[cs]e|copying)(\.|$)/i.test(a.nombre));
const textoLicencia = licencia ? leer(licencia).slice(0, 400) : '';
const tipoLicencia = !licencia ? 'no encontrada'
  : /\bMIT\b/.test(textoLicencia) ? 'MIT'
  : /Apache/i.test(textoLicencia) ? 'Apache'
  : /GNU AFFERO|AGPL/i.test(textoLicencia) ? 'AGPL'
  : /GNU GENERAL|GPL/i.test(textoLicencia) ? 'GPL'
  : /\bBSD\b/.test(textoLicencia) ? 'BSD'
  : 'otra, leer el archivo';

const ejecutables = archivos.filter((a) => EJECUTABLE.has(a.ext));
const ORDEN = { critica: 0, alta: 1, media: 2, doc: 3 };
señales.sort((a, b) => ORDEN[a.nivel] - ORDEN[b.nivel] || a.tipo.localeCompare(b.tipo));
const cuenta = (n) => señales.filter((s) => s.nivel === n).length;

// Se agrupan las repeticiones: 200 fetch iguales no aportan más que uno con su total.
const grupos = new Map();
for (const s of señales) {
  const clave = `${s.nivel}|${s.tipo}|${s.archivo}`;
  if (!grupos.has(clave)) grupos.set(clave, { ...s, veces: 0, lineas: [] });
  const g = grupos.get(clave);
  g.veces++;
  if (s.linea && g.lineas.length < 8) g.lineas.push(s.linea);
}
const agrupadas = [...grupos.values()].map(({ linea, ...g }) => g);

const informe = {
  objetivo: basename(raiz.replace(/[\\/]+$/, '')),
  tipos,
  licencia: tipoLicencia,
  totalArchivos: archivos.length,
  pesoKb: +(archivos.reduce((t, a) => t + a.bytes, 0) / 1024).toFixed(1),
  componentes: { skills: skillsMd.length, plugins: plugins.length, subagentes: agentes.length, comandos: comandos.length, hooks: hooksJson.length, servidoresMcp: mcp.length },
  archivosEjecutables: ejecutables.length,
  ejecutablesEjemplo: ejecutables.slice(0, 15).map((a) => a.r),
  costoContexto: {
    tokensSiempreCargados: costoSkills.reduce((t, s) => t + s.tokensSiempre, 0) + costoAgentes,
    tokensMayorActivacion: Math.max(0, ...costoSkills.map((s) => s.tokensAlActivar)),
    nota: 'Estimación de 4 caracteres por token. No cuenta las definiciones de herramientas de servidores MCP.',
    skills: costoSkills.slice(0, 40),
  },
  resumenSeñales: { criticas: cuenta('critica'), altas: cuenta('alta'), medias: cuenta('media'), enDocumentacion: cuenta('doc') },
  señales: agrupadas.slice(0, 120),
  señalesOmitidas: Math.max(0, agrupadas.length - 120),
};
console.log(JSON.stringify(informe, null, 2));
process.exit(cuenta('critica') ? 2 : 0);
