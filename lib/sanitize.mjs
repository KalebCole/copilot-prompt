/**
 * Conservative markdown safety net for LLM output. Used by extractRewrite
 * as a fallback when the model omits <<<PROMPT>>>...<<<END>>> markers.
 *
 * Rules (applied in order, every rule provably idempotent):
 *  1. Opening code fences  (``` or ~~~, optional language tag)  — anchored to line start.
 *  2. Closing code fences  (``` or ~~~)                          — whole-line match only.
 *  3. ATX headers          (#, ##, ... ######)                   — REQUIRES a space after #
 *                                                                    so `#hashtag` and
 *                                                                    `#!shebang` survive.
 *  4. Thematic breaks      (---, ***, ___, spaced variants)      — backreference \1
 *                                                                    enforces a single
 *                                                                    separator char per line.
 *  5. Blockquote markers   (`> `)                                — REQUIRES a space after `>`
 *                                                                    so `>file.txt` shell
 *                                                                    redirects survive.
 *
 * Bold (`**`/`__`) and italic (`*`/`_`) are intentionally NOT stripped — collision risk
 * with `**kwargs`, `__init__`, `2**8`, `*.txt`. Those leak shapes are addressed by the
 * <output_format> SYSTEM_PROMPT block instead.
 *
 * Known limitation: YAML `---` document separators are stripped by rule 4. Accepted.
 */
export function sanitizePrompt(text) {
  if (!text) return text;
  let s = text;

  // 1. Opening fences (both ``` and ~~~). Anchored to line start.
  s = s.replace(/^(`{3,}|~{3,})[^\n]*\n?/gm, "");

  // 2. Closing fences (both ``` and ~~~). Whole-line match only.
  s = s.replace(/^(`{3,}|~{3,})[ \t]*$/gm, "");

  // 3. ATX headers: strip leading #+ space prefix, keep text.
  //    Mandatory space after # — so #hashtag and #!shebang are safe.
  s = s.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*\s*$/gm, "$1");

  // 4. Thematic breaks: ---, ***, ___ (and spaced variants like - - -).
  //    Backreference \1 ensures all separator chars match.
  s = s.replace(/^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, "");

  // 5. Blockquote markers: > with MANDATORY following space.
  //    Mandatory space skips `> /dev/null` shell redirects.
  s = s.replace(/^[ \t]*> /gm, "");

  return s.trim();
}
