#!/usr/bin/env node
// Auditoría estática de una landing: peso, rendimiento y fallas de código.
// Sin dependencias. No ejecuta el código de la página ni modifica archivos.
//
// Uso: node auditar.mjs <carpeta> [--json] [--presupuesto 100] [--max 5]
// Salida: 0 sin fallas altas · 2 con fallas altas · 1 error de uso

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, dirname, resolve, basename, sep } from 'node:path';

const args = process.argv.slice(2);
const opcion = (nombre, porDefecto) => {
  const i = args.indexOf(nombre);
  return i === -1 ? porDefecto : Number(args[i + 1]);
};
const comoJson = args.includes('--json');
const PRESUPUESTO_KB = opcion('--presupuesto', 100);
const MAX_POR_REGLA = opcion('--max', 5);
const raiz = args.find((a, i) => !a.startsWith('--') && !['--presupuesto', '--max'].includes(args[i - 1]));

if (!raiz || !existsSync(raiz) || !statSync(raiz).isDirectory()) {
  console.error('Uso: node auditar.mjs <carpeta-de-la-landing> [--json] [--presupuesto 100] [--max 5]');
  process.exit(1);
}

const CARPETAS_IGNORADAS = new Set(['node_modules', 'graphify-out', 'dist', 'build', 'coverage']);
const EXT = {
  html: new Set(['.html', '.htm']),
  css: new Set(['.css']),
  js: new Set(['.js', '.mjs']),
  imagen: new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg']),
  fuente: new Set(['.woff2', '.woff', '.ttf', '.otf']),
  video: new Set(['.mp4', '.webm', '.mov']),
};

const archivos = [];
const secretosEnCarpeta = [];
(function recorrer(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) {
      if (!CARPETAS_IGNORADAS.has(e.name) && !e.name.startsWith('.') && !e.name.startsWith('_')) recorrer(ruta);
      continue;
    }
    if (/^\.env(\.|$)/.test(e.name) && !/\.example$/.test(e.name)) secretosEnCarpeta.push(ruta);
    const ext = extname(e.name).toLowerCase();
    const tipo = Object.keys(EXT).find((t) => EXT[t].has(ext));
    if (tipo) archivos.push({ ruta, tipo, nombre: e.name, bytes: statSync(ruta).size });
  }
})(raiz);

const rel = (r) => relative(raiz, r).split(sep).join('/');
const leer = (r) => readFileSync(r, 'utf8');
const kb = (b) => (b / 1024).toFixed(1);
const enBlanco = (s) => s.replace(/[^\n]/g, ' ');
const lineaDe = (texto, indice) => texto.slice(0, indice).split('\n').length;

const hallazgos = [];
function falla(sev, regla, archivo, linea, problema, arreglo) {
  hallazgos.push({ sev, regla, archivo: rel(archivo), linea, problema, arreglo });
}

const RE_ETIQUETA = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
function atributos(crudo) {
  const a = {};
  for (const m of crudo.matchAll(/([:@\w-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
    a[m[1].toLowerCase()] = m[2] === undefined ? '' : m[2].replace(/^["']|["']$/g, '');
  }
  return a;
}
const esExterno = (u) => /^(https?:)?\/\//i.test(u);
const esIgnorable = (u) => !u || /^(#|data:|mailto:|tel:|javascript:|sms:|blob:|\{|\$)/i.test(u);
const limpiarUrl = (u) => { try { return decodeURIComponent(u.split(/[?#]/)[0]); } catch { return u.split(/[?#]/)[0]; } };

function comprobarReferencia(url, desde, linea, etiqueta) {
  if (esIgnorable(url) || esExterno(url)) return;
  const limpia = limpiarUrl(url);
  if (!limpia) return;
  const base = limpia.startsWith('/') ? join(raiz, limpia) : resolve(dirname(desde), limpia);
  const candidatos = [base, `${base}.html`, join(base, 'index.html')];
  const ok = candidatos.some((c) => existsSync(c));
  if (!ok) falla('alta', 'referencia-rota', desde, linea, `${etiqueta} apunta a «${url}», que no existe.`, 'Corrige la ruta o sube el archivo.');
}

const textoCss = [];
const textoJs = [];
const origenes = new Set();
let totalEtiquetas = 0;

for (const html of archivos.filter((a) => a.tipo === 'html')) {
  const crudo = leer(html.ruta);
  const sinComentarios = crudo.replace(/<!--[\s\S]*?-->/g, enBlanco);

  for (const m of sinComentarios.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const inicio = m.index + m[0].indexOf(m[1]);
    textoCss.push({ ruta: html.ruta, texto: enBlanco(sinComentarios.slice(0, inicio)) + m[1] });
  }
  for (const m of sinComentarios.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const tipo = atributos(m[1]).type || '';
    if (/json|importmap|template/i.test(tipo) || !m[2].trim()) continue;
    const inicio = m.index + m[0].indexOf(m[2], m[1].length);
    textoJs.push({ ruta: html.ruta, texto: enBlanco(sinComentarios.slice(0, inicio)) + m[2] });
    if (m[2].length > 30 * 1024) {
      falla('media', 'js-inline-pesado', html.ruta, lineaDe(sinComentarios, inicio), `Script en línea de ${kb(m[2].length)} KB: no se puede cachear entre páginas.`, 'Muévelo a un archivo .js con defer.');
    }
  }

  const marcado = sinComentarios.replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi, (_, a, __, c, d) => a + enBlanco(c) + d);
  const finHead = marcado.search(/<\/head>/i);
  const ids = new Map();
  let h1 = 0, primeraImagen = true, hayCanonical = false, hayFavicon = false;
  let hayOg = false, hayDescripcion = false, hayViewport = false, hayTitulo = false;

  for (const m of marcado.matchAll(RE_ETIQUETA)) {
    const tag = m[1].toLowerCase();
    const a = atributos(m[2]);
    const linea = lineaDe(marcado, m.index);
    totalEtiquetas++;

    if (a.id) {
      if (ids.has(a.id)) falla('alta', 'id-duplicado', html.ruta, linea, `El id «${a.id}» ya se usó en la línea ${ids.get(a.id)}.`, 'Cada id debe ser único: rompe anclas, label y JavaScript.');
      else ids.set(a.id, linea);
    }
    if (a.tabindex && Number(a.tabindex) > 0) falla('media', 'tabindex-positivo', html.ruta, linea, `tabindex="${a.tabindex}" altera el orden del teclado.`, 'Usa 0 o reordena el HTML.');
    if (Object.keys(a).some((k) => /^on[a-z]+$/.test(k))) falla('baja', 'evento-en-linea', html.ruta, linea, 'Manejador de evento escrito en el HTML.', 'Pásalo a addEventListener; también facilita una CSP estricta.');

    for (const attr of ['src', 'href', 'poster']) {
      if (a[attr] && /^http:\/\//i.test(a[attr]) && !/localhost|127\.0\.0\.1/.test(a[attr]) && tag !== 'a') {
        falla('alta', 'contenido-mixto', html.ruta, linea, `<${tag}> carga por http: ${a[attr]}`, 'Cámbialo a https o el navegador lo bloqueará.');
      }
    }
    if (a.src) { comprobarReferencia(a.src, html.ruta, linea, `<${tag} src>`); if (esExterno(a.src)) origenes.add(new URL(a.src, 'https://x').host); }
    if (a.poster) comprobarReferencia(a.poster, html.ruta, linea, `<${tag} poster>`);
    if (a.href && ['link', 'a'].includes(tag)) comprobarReferencia(a.href, html.ruta, linea, `<${tag} href>`);

    if (tag === 'script' && a.src && m.index < finHead && !('defer' in a) && !('async' in a) && a.type !== 'module') {
      falla('alta', 'script-bloqueante', html.ruta, linea, `«${a.src}» detiene el pintado de la página.`, 'Agrega defer, o muévelo al final del body.');
    }
    if (tag === 'link') {
      const relacion = (a.rel || '').toLowerCase();
      if (relacion === 'canonical') hayCanonical = true;
      if (relacion.includes('icon')) hayFavicon = true;
      if (relacion === 'stylesheet' && a.href) {
        if (esExterno(a.href)) origenes.add(new URL(a.href, 'https://x').host);
        if (/fonts\.googleapis\.com/.test(a.href) && !/display=swap/.test(a.href)) {
          falla('media', 'fuente-sin-swap', html.ruta, linea, 'Google Fonts sin display=swap: el texto puede quedar invisible al cargar.', 'Agrega &display=swap a la URL.');
        }
      }
    }
    if (tag === 'meta') {
      if (a.name === 'viewport') {
        hayViewport = true;
        if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(a.content || '')) {
          falla('alta', 'zoom-bloqueado', html.ruta, linea, 'La página impide hacer zoom.', 'Quita user-scalable=no y maximum-scale=1.');
        }
      }
      if (a.name === 'description' && a.content) hayDescripcion = true;
      if (a.property === 'og:image') hayOg = true;
    }
    if (tag === 'title') hayTitulo = true;
    if (tag === 'h1') h1++;

    if (tag === 'img') {
      if (!('alt' in a)) falla('alta', 'imagen-sin-alt', html.ruta, linea, `La imagen «${a.src || '?'}» no tiene alt.`, 'Describe la imagen, o usa alt="" si es decorativa.');
      const estiloDa = /aspect-ratio|(^|;)\s*(width|height)\s*:/i.test(a.style || '');
      if (!(a.width && a.height) && !estiloDa) falla('media', 'imagen-sin-medidas', html.ruta, linea, `«${a.src || '?'}» no declara width y height: la página salta al cargar (CLS).`, 'Agrega width y height con su tamaño real.');
      if (primeraImagen && a.loading === 'lazy') falla('media', 'lcp-diferida', html.ruta, linea, 'La primera imagen tiene loading="lazy": retrasa lo primero que se ve (LCP).', 'Quita lazy en la primera imagen y agrega fetchpriority="high".');
      const local = a.src && !esExterno(a.src) && !esIgnorable(a.src) ? (a.src.startsWith('/') ? join(raiz, limpiarUrl(a.src)) : resolve(dirname(html.ruta), limpiarUrl(a.src))) : null;
      const esLigera = local && existsSync(local) && statSync(local).size < 20 * 1024;
      if (!primeraImagen && a.loading !== 'lazy' && !esLigera) falla('baja', 'imagen-sin-lazy', html.ruta, linea, `«${a.src || '?'}» se descarga aunque no esté a la vista.`, 'Agrega loading="lazy".');
      primeraImagen = false;
    }
    if (tag === 'video' && 'autoplay' in a) {
      if (!a.poster) falla('media', 'video-sin-poster', html.ruta, linea, 'Video automático sin poster: hueco vacío mientras carga.', 'Agrega poster con un fotograma comprimido.');
      if (!('muted' in a) || !('playsinline' in a)) falla('alta', 'video-autoplay', html.ruta, linea, 'autoplay sin muted y playsinline: no arranca en iPhone.', 'Agrega muted y playsinline.');
    }
    if (tag === 'a') {
      if (a.href === '#' || a.href === '') falla('media', 'enlace-vacio', html.ruta, linea, 'Enlace sin destino real (href vacío o «#»).', 'Pon el destino, o usa <button> si ejecuta una acción.');
      if (a.target === '_blank' && !/noopener|noreferrer/.test(a.rel || '')) falla('baja', 'blank-sin-rel', html.ruta, linea, 'target="_blank" sin rel.', 'Agrega rel="noopener".');
    }
    if (tag === 'button' && !a.type) falla('baja', 'boton-sin-type', html.ruta, linea, '<button> sin type: dentro de un formulario lo envía.', 'Agrega type="button" o type="submit".');
    if (tag === 'button' || (tag === 'a' && a.href)) {
      const cierre = marcado.indexOf(`</${tag}`, m.index);
      const interior = cierre === -1 ? '' : marcado.slice(m.index + m[0].length, cierre);
      const texto = interior.replace(/<[^>]+>/g, '').trim();
      const tieneNombreEnHijo = /aria-label=|alt="[^"]+"|<title>/i.test(interior);
      if (!texto && !a['aria-label'] && !a['aria-labelledby'] && !a.title && !tieneNombreEnHijo) {
        falla('alta', 'control-sin-nombre', html.ruta, linea, `<${tag}> no tiene texto ni aria-label: un lector de pantalla no sabe qué hace.`, 'Agrega aria-label.');
      }
    }
    if (['input', 'select', 'textarea'].includes(tag) && !['hidden', 'submit', 'button'].includes(a.type)) {
      const conLabel = a.id && new RegExp(`for=["']${a.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(marcado);
      const antes = marcado.slice(Math.max(0, m.index - 300), m.index);
      const dentroDeLabel = /<label\b(?![\s\S]*<\/label>)/i.test(antes);
      if (!conLabel && !dentroDeLabel && !a['aria-label'] && !a['aria-labelledby']) {
        falla('alta', 'campo-sin-label', html.ruta, linea, `<${tag}> sin etiqueta asociada; el placeholder no cuenta.`, 'Agrega <label for> o aria-label.');
      }
    }
  }

  const raizHtml = marcado.match(/<html\b([^>]*)>/i);
  if (!raizHtml || !atributos(raizHtml[1]).lang) falla('alta', 'sin-lang', html.ruta, 1, 'Falta lang en <html>.', 'Agrega lang="es".');
  if (!hayViewport) falla('alta', 'sin-viewport', html.ruta, 1, 'Sin meta viewport: en móvil se ve como escritorio.', 'Agrega <meta name="viewport" content="width=device-width, initial-scale=1">.');
  if (!hayTitulo) falla('alta', 'sin-title', html.ruta, 1, 'Sin <title>.', 'Agrega un título con el resultado que promete la página.');
  if (!hayDescripcion) falla('media', 'sin-description', html.ruta, 1, 'Sin meta description.', 'Agrega una descripción de 120 a 155 caracteres.');
  if (h1 !== 1) falla('media', 'h1-incorrecto', html.ruta, 1, `La página tiene ${h1} <h1>.`, 'Deja exactamente uno.');
  if (!hayOg) falla('baja', 'sin-og-image', html.ruta, 1, 'Sin og:image: el enlace se comparte sin imagen.', 'Agrega <meta property="og:image">.');
  if (!hayCanonical) falla('baja', 'sin-canonical', html.ruta, 1, 'Sin URL canónica.', 'Agrega <link rel="canonical">.');
  if (!hayFavicon) falla('baja', 'sin-favicon', html.ruta, 1, 'Sin favicon declarado.', 'Agrega <link rel="icon">.');

  // «TODO» es palabra común en español: no se busca. <code> y <pre> se saltan porque enseñan plantillas.
  const visible = marcado
    .replace(/<(code|pre)\b[^>]*>[\s\S]*?<\/\1>/gi, enBlanco)
    .replace(/<[^>]+>/g, (t) => enBlanco(t));
  for (const m of visible.matchAll(/\[(?:[A-ZÁÉÍÓÚÑ]{3,}[A-ZÁÉÍÓÚÑ :_-]*)\]|\blorem ipsum\b|\bFIXME\b/gi)) {
    if (m[0].startsWith('[') && m[0] !== m[0].toUpperCase()) continue;
    falla('alta', 'texto-provisional', html.ruta, lineaDe(visible, m.index), `Texto provisional visible: «${m[0]}».`, 'Reemplázalo antes de publicar.');
  }
}

for (const css of archivos.filter((a) => a.tipo === 'css')) textoCss.push({ ruta: css.ruta, texto: leer(css.ruta) });
for (const js of archivos.filter((a) => a.tipo === 'js')) textoJs.push({ ruta: js.ruta, texto: leer(js.ruta) });

function enmascararMedia(css) {
  let salida = css;
  for (const m of css.matchAll(/@media[^{]*\{/g)) {
    let prof = 1, i = m.index + m[0].length;
    while (i < css.length && prof > 0) { if (css[i] === '{') prof++; else if (css[i] === '}') prof--; i++; }
    salida = salida.slice(0, m.index) + enBlanco(css.slice(m.index, i)) + salida.slice(i);
  }
  return salida;
}

const PROP_LAYOUT = /\b(top|left|right|bottom|width|height|margin(-\w+)?|padding(-\w+)?)\s*:/;
let hayAnimacion = false, hayReduced = false, hayFocusVisible = false, usosWillChange = 0, usosBackdrop = 0;

for (const { ruta, texto } of textoCss) {
  const css = texto.replace(/\/\*[\s\S]*?\*\//g, enBlanco);
  if (/@keyframes|\btransition\s*:|\banimation\s*:/.test(css)) hayAnimacion = true;
  if (/prefers-reduced-motion/.test(css)) hayReduced = true;
  if (/:focus-visible|:focus\b/.test(css)) hayFocusVisible = true;
  usosWillChange += (css.match(/will-change\s*:/g) || []).length;
  usosBackdrop += (css.match(/backdrop-filter\s*:/g) || []).length;

  for (const m of css.matchAll(/transition\s*:\s*all\b/g)) {
    falla('media', 'transition-all', ruta, lineaDe(css, m.index), 'transition: all anima también propiedades caras.', 'Nombra solo transform, opacity o las que necesites.');
  }
  for (const m of css.matchAll(/transition(?:-property)?\s*:\s*([^;}]*)/g)) {
    if (/\b(width|height|top|left|right|bottom|margin|padding)\b/.test(m[1])) {
      falla('media', 'transition-layout', ruta, lineaDe(css, m.index), `Transición sobre layout: «${m[1].trim().slice(0, 50)}».`, 'Usa transform: el navegador no recalcula la página.');
    }
  }
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let prof = 1, i = m.index + m[0].length;
    while (i < css.length && prof > 0) { if (css[i] === '{') prof++; else if (css[i] === '}') prof--; i++; }
    if (PROP_LAYOUT.test(css.slice(m.index + m[0].length, i))) {
      falla('media', 'keyframes-layout', ruta, lineaDe(css, m.index), `La animación «${m[1]}» mueve propiedades de layout.`, 'Reescríbela con transform y opacity.');
    }
  }
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    if (!/font-display/.test(m[1])) falla('media', 'fontface-sin-display', ruta, lineaDe(css, m.index), '@font-face sin font-display.', 'Agrega font-display: swap.');
  }
  for (const m of css.matchAll(/outline\s*:\s*(none|0)\b/g)) {
    if (!/:focus-visible/.test(css)) falla('media', 'foco-eliminado', ruta, lineaDe(css, m.index), 'Se quita el contorno de foco sin reemplazo.', 'Define un estilo :focus-visible.');
  }
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) comprobarReferencia(m[1], ruta, lineaDe(css, m.index), 'url()');

  const base = enmascararMedia(css);
  for (const m of base.matchAll(/(?<![-\w])(?<prop>width|min-width)\s*:\s*(\d{3,4})px/g)) {
    if (Number(m[2]) > 360) falla('media', 'ancho-fijo', ruta, lineaDe(base, m.index), `${m.groups.prop}: ${m[2]}px fuera de media query: posible scroll horizontal en móvil.`, 'Usa max-width o min(100%, valor).');
  }
}
if (hayAnimacion && !hayReduced) falla('media', 'sin-reduced-motion', archivos.find((a) => a.tipo === 'html')?.ruta || raiz, 1, 'Hay animaciones y ninguna regla prefers-reduced-motion.', 'Desactívalas dentro de @media (prefers-reduced-motion: reduce).');
if (usosWillChange > 6) falla('baja', 'exceso-will-change', raiz, 0, `will-change aparece ${usosWillChange} veces: consume memoria de GPU.`, 'Déjalo solo en lo que se anima de verdad.');
if (usosBackdrop > 5) falla('baja', 'exceso-backdrop', raiz, 0, `backdrop-filter aparece ${usosBackdrop} veces: caro en móviles de gama baja.`, 'Limítalo a uno o dos elementos.');

const SECRETOS = [
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/g, 'clave tipo sk-'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'clave de Google'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, 'token de GitHub'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'clave de AWS'],
  [/\bxox[abps]-[A-Za-z0-9-]{10,}\b/g, 'token de Slack'],
];
for (const { ruta, texto } of textoJs) {
  for (const m of texto.matchAll(/\bdocument\.write\s*\(/g)) falla('alta', 'document-write', ruta, lineaDe(texto, m.index), 'document.write bloquea el pintado.', 'Inserta el contenido con el DOM.');
  for (const m of texto.matchAll(/(?<![\w.])eval\s*\(|new\s+Function\s*\(/g)) falla('alta', 'eval', ruta, lineaDe(texto, m.index), 'Ejecuta texto como código.', 'Elimínalo.');
  for (const m of texto.matchAll(/\.innerHTML\s*\+?=\s*(?!["'`]\s*["'`])([^;\n]*)/g)) {
    if (/\b(location|search|hash|params|input|value|response|data)\b/i.test(m[1])) falla('media', 'innerhtml-datos', ruta, lineaDe(texto, m.index), 'innerHTML recibe datos externos: riesgo de XSS.', 'Usa textContent o sanea el valor.');
  }
  for (const m of texto.matchAll(/addEventListener\(\s*["'](scroll|touchmove|wheel)["'][^)]*\)/g)) {
    if (!/passive/.test(m[0])) falla('media', 'listener-no-pasivo', ruta, lineaDe(texto, m.index), `Listener de ${m[1]} sin passive: el scroll se traba.`, 'Agrega { passive: true }.');
  }
}
for (const fuente of [...textoJs, ...archivos.filter((a) => a.tipo === 'html').map((a) => ({ ruta: a.ruta, texto: leer(a.ruta) }))]) {
  for (const [re, nombre] of SECRETOS) {
    for (const m of fuente.texto.matchAll(re)) falla('alta', 'secreto-expuesto', fuente.ruta, lineaDe(fuente.texto, m.index), `Posible ${nombre}: ${m[0].slice(0, 6)}…`, 'Revócala y muévela a una variable de entorno en el servidor.');
  }
}
const ignorados = ['.gitignore', '.vercelignore'].map((f) => join(raiz, f)).filter(existsSync).map(leer).join('\n');
for (const r of secretosEnCarpeta) {
  if (/^\s*\.env/m.test(ignorados)) falla('baja', 'env-ignorado', r, 0, 'Hay un .env en la carpeta, aunque un archivo de ignorados lo excluye.', 'Confirma que el despliegue respeta ese archivo.');
  else falla('alta', 'env-en-carpeta', r, 0, 'Archivo .env dentro de la carpeta que se publica.', 'Sácalo de la carpeta y agrégalo a .gitignore.');
}
if (totalEtiquetas > 1500) falla('media', 'dom-grande', raiz, 0, `${totalEtiquetas} etiquetas HTML: el navegador tarda más en calcular estilos.`, 'Reduce envoltorios o renderiza por partes.');
if (origenes.size > 3) falla('media', 'muchos-origenes', raiz, 0, `Carga de ${origenes.size} dominios externos: ${[...origenes].join(', ')}.`, 'Aloja los recursos en tu dominio.');

const corpus = archivos.filter((a) => ['html', 'css', 'js'].includes(a.tipo)).map((a) => leer(a.ruta)).join('\n');
for (const a of archivos) {
  if (a.tipo === 'imagen') {
    if (a.bytes > 500 * 1024) falla('alta', 'imagen-enorme', a.ruta, 0, `Pesa ${kb(a.bytes)} KB.`, 'Redimensiónala y expórtala a WebP o AVIF.');
    else if (a.bytes > 150 * 1024) falla('media', 'imagen-pesada', a.ruta, 0, `Pesa ${kb(a.bytes)} KB.`, 'Comprímela por debajo de 150 KB.');
    else if (/\.(png|jpe?g)$/i.test(a.nombre) && a.bytes > 50 * 1024) falla('baja', 'formato-antiguo', a.ruta, 0, `${kb(a.bytes)} KB en formato antiguo.`, 'Convierte a WebP o AVIF.');
  }
  if (a.tipo === 'video' && a.bytes > 5 * 1024 * 1024) falla('media', 'video-pesado', a.ruta, 0, `Pesa ${(a.bytes / 1048576).toFixed(1)} MB.`, 'Comprímelo o entrégalo por streaming.');
  if (['imagen', 'fuente', 'video'].includes(a.tipo) && !corpus.includes(a.nombre) && !corpus.includes(encodeURI(a.nombre)) && !/^(favicon|apple-touch|og|android-chrome)/i.test(a.nombre)) {
    falla('baja', 'archivo-sin-uso', a.ruta, 0, `«${basename(a.nombre)}» no se usa en ninguna página.`, 'Bórralo para aligerar el despliegue.');
  }
}

const suma = (tipos) => archivos.filter((a) => tipos.includes(a.tipo)).reduce((t, a) => t + a.bytes, 0);
const peso = { textoKb: +kb(suma(['html', 'css', 'js'])), imagenesKb: +kb(suma(['imagen'])), fuentesKb: +kb(suma(['fuente'])), videoKb: +kb(suma(['video'])) };
if (peso.textoKb > PRESUPUESTO_KB) {
  falla('media', 'presupuesto-superado', raiz, 0, `HTML, CSS y JS suman ${peso.textoKb} KB; el presupuesto es ${PRESUPUESTO_KB} KB.`, 'Recorta primero el archivo más pesado de la tabla.');
}

const ORDEN = { alta: 0, media: 1, baja: 2 };
hallazgos.sort((a, b) => ORDEN[a.sev] - ORDEN[b.sev] || a.regla.localeCompare(b.regla) || a.archivo.localeCompare(b.archivo) || a.linea - b.linea);
const cuenta = (s) => hallazgos.filter((h) => h.sev === s).length;

// La nota descuenta por regla, no por repetición: 40 imágenes sin lazy son un solo descuido.
const reglas = new Map();
for (const h of hallazgos) reglas.set(h.regla, h.sev);
const descuento = { alta: 15, media: 5, baja: 1 };
const nota = Math.max(0, 100 - [...reglas.values()].reduce((t, s) => t + descuento[s], 0));
const pesados = [...archivos].sort((a, b) => b.bytes - a.bytes).slice(0, 3).map((a) => ({ archivo: rel(a.ruta), kb: +kb(a.bytes) }));
const informe = { carpeta: raiz, nota, altas: cuenta('alta'), medias: cuenta('media'), bajas: cuenta('baja'), peso, presupuestoKb: PRESUPUESTO_KB, masPesados: pesados, origenesExternos: [...origenes], hallazgos };

if (comoJson) {
  console.log(JSON.stringify(informe, null, 2));
} else {
  console.log(`AUDITORÍA DE LANDING · ${raiz}`);
  console.log(`Nota ${nota}/100 · ${informe.altas} altas · ${informe.medias} medias · ${informe.bajas} bajas\n`);
  console.log(`Peso: texto ${peso.textoKb}/${PRESUPUESTO_KB} KB · imágenes ${peso.imagenesKb} KB · fuentes ${peso.fuentesKb} KB · video ${peso.videoKb} KB`);
  console.log(`Más pesados: ${pesados.map((p) => `${p.archivo} (${p.kb} KB)`).join(' · ')}`);
  console.log(`Dominios externos: ${[...origenes].join(', ') || 'ninguno'}\n`);
  const vistos = new Map();
  for (const h of hallazgos) {
    const n = (vistos.get(h.regla) || 0) + 1;
    vistos.set(h.regla, n);
    if (n > MAX_POR_REGLA) continue;
    console.log(`[${h.sev.toUpperCase()}] ${h.regla} · ${h.archivo}${h.linea ? `:${h.linea}` : ''}`);
    console.log(`  ${h.problema}`);
    console.log(`  Arreglo: ${h.arreglo}`);
  }
  for (const [regla, n] of vistos) if (n > MAX_POR_REGLA) console.log(`… y ${n - MAX_POR_REGLA} más de ${regla} (usa --max 999 para verlas).`);
  if (!hallazgos.length) console.log('Sin hallazgos.');
}
process.exit(informe.altas ? 2 : 0);
