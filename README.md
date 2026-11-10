# skills-portables

Una sola carpeta de skills que funciona en **Claude Code** y en **Codex**. Las dos leen el mismo formato (una carpeta con `SKILL.md`), así que no hace falta mantener dos copias: se guarda en un lugar y se enlaza.

## Qué obtienes
- La estructura recomendada para compartir skills entre las dos herramientas.
- `peso-landing`: audita una landing como un code review antes de publicarla. Mide peso, rendimiento (imágenes sin medidas o sin carga diferida, animaciones que mueven el layout, fuentes y scripts que bloquean), accesibilidad básica, enlaces rotos, texto de relleno y archivos `.env` expuestos. Da una nota sobre 100 y un veredicto: LISTA, ARREGLAR ANTES o NO PUBLICAR.
- `antes-de-instalar`: decide si vale la pena instalar un plugin, una skill, un servidor MCP o un repositorio de GitHub. Escanea tu flujo de trabajo y tu código, hace una radiografía estática del objetivo (sin instalarlo ni ejecutarlo) y entrega pros, contras y recomendación: INSTALAR, PROBAR EN AISLADO o NO INSTALAR.

## Rutas de instalación

| Herramienta | Todos tus proyectos | Solo este proyecto |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex | `~/.agents/skills/` | `.agents/skills/` |

## Una carpeta, dos herramientas
Guarda las skills en `.agents/skills/` y enlázalas para Claude Code.

```bash
# macOS / Linux
mkdir -p .agents/skills .claude
ln -s ../.agents/skills .claude/skills
```

```powershell
# Windows (PowerShell, sin administrador: una unión de carpeta)
New-Item -ItemType Directory -Force .agents\skills, .claude | Out-Null
New-Item -ItemType Junction -Path .claude\skills -Target (Resolve-Path .agents\skills).Path
```

Copia `skills/peso-landing/` y `skills/antes-de-instalar/` dentro de `.agents/skills/`, reinicia la herramienta y comprueba con `/skills`.

## Uso
- Claude Code: `/peso-landing`, `/antes-de-instalar`
- Codex: `$peso-landing`, `$antes-de-instalar`

Sin agente (Node 18 o superior, sin dependencias):

```bash
node skills/peso-landing/scripts/auditar.mjs <carpeta-de-la-landing>
node skills/antes-de-instalar/scripts/perfil.mjs <tu-proyecto> --global
node skills/antes-de-instalar/scripts/radiografia.mjs <carpeta-del-plugin-o-repo>
```

## Límites reales
- **Prueba en Claude Code y en Codex pendiente.** Los scripts se corrieron con Node en Windows; que cada herramienta descubra e invoque las skills a través del enlace no está probado todavía.
- `antes-de-instalar` hace análisis estático: busca patrones de riesgo (descargas que se ejecutan, lectura de credenciales o cookies, comandos destructivos, hooks automáticos). Que no encuentre nada no prueba que algo sea seguro, y puede marcar falsos positivos que hay que leer a mano.
- `peso-landing` revisa archivos, no mide la página en un navegador. Para Core Web Vitals reales usa Lighthouse o PageSpeed Insights.
- Un documento de terceros (`wshobson/agents`, `docs/harnesses.md`) afirma que Codex recorta el cuerpo de una skill a 8 KB; la documentación de Codex que revisé no lo menciona. Mantén tus `SKILL.md` cortos.
- En Windows el symlink exige administrador; por eso se usa una unión (`Junction`). Si falla, copia la carpeta.

## Seguridad
Instalar una skill de terceros trae código a tu equipo. Lee `SKILL.md` y `scripts/` antes de usarla, o pásala primero por `antes-de-instalar`.

## Licencia
MIT. Ver `LICENSE`.

Autor: Stéfano Coronado. Instagram: [@stefanocoronadoo](https://www.instagram.com/stefanocoronadoo/).
