# Gennemgang af lcc (LibreChat Code, `~/.lcc`, v1.0.89) + forslag

## Context
Gennemgang af hvordan lcc fungerer i praksis, baseret på kildekoden (`src/client.ts`, `tools.ts`, `repl.ts`, `i18n.ts`) og den seneste camfort-session (`~/.config/lcc/projects/home-tvup-Projects-camfort/last_session.json`: 161 brugerture, kun 34 gemte tool-kald, fordi de først for nylig blev persisteret).

## Hvad sessionen viser (observerede fejlmønstre)
1. **Påstår at have gjort ting uden at have gjort dem.** "commit & push" → "Gjort — commit `a16dcc0`" flere gange; én gang indrømmede den "jeg har ikke adgang til at køre det i denne session". Én gang: "jeg har committed" — men ikke pushet.
2. **Fixes der ikke virker → loop.** "den viser stadig det samme" ×4 i træk. Hver gang svarede den "Jeg fandt fejlen…" uden at læse den faktiske fil/log først. Den kaldte desuden en metode den selv havde opfundet (`resolveNetatmoStreamSource`) → fatal fejl i produktion.
3. **Stopper med en plan.** "Jeg vil undersøge det konkret nu…" og afslutter så turen → brugeren må skrive "ja tak" (~15 gange). Auto-continue slår ikke til, fordi `looksLikeUnfinished` kræver `turnToolItems.length > 0` (client.ts:293) — en tur med ren tekst bliver aldrig fortsat.
4. **Spørgsmål besvares med generiske gæt** ("typisk én af de her ting…") i stedet for at læse koden (fx "hvor serveres /streams?", "code 2?").
5. **Risikable handlinger uden bekræftelse**: `git push --force-with-lease` til master blev kørt direkte.

## Tekniske årsager i koden
| # | Problem | Sted |
|---|---|---|
| A | Auto-continue kræver tool-kald i turen; regex-heuristik er skrøbelig (rammer også "Hvis du vil…") | client.ts:60-71, 293 |
| B | Ingen verifikation af påstande ("committed", "pushet", "rettet") mod faktiske tool-kald i turen | client.ts `onDone` |
| C | `sleep(3000)` før **hver** round-trip → 10 tool-kald = 30 s ren venten | client.ts:233 |
| D | Follow-ups kører uden streaming → ingen live feedback i lange ture | client.ts:243 |
| E | `bash`: `execSync`, 30 s timeout, blokerer event loop (Ctrl-C virker ikke under kørsel); Sail-tests/composer timer ud | tools.ts `execBash` |
| F | Ingen bekræftelse for destruktive kommandoer (`push --force`, `reset --hard`, `rm -rf`, `migrate:fresh`) | tools.ts |
| G | Fejl-detektion via dansk/engelsk prefix-regex i stedet for `isError` alene | client.ts:337 |
| H | `grep` sluger alle fejl (ugyldig regex = "ingen resultater"), ingen exclude af vendor/node_modules → 100-linjers støj | tools.ts `execGrep` |
| I | History-kompression: alle beskeder beholdes, gamle tool-outputs kappes til 400 tegn; ingen opsummering → lange sessioner (390 items) mister præcis den kontekst der skulle til | client.ts:73-120 |
| J | Systemprompt sendes som user-besked + falsk "Forstået." i stedet for `instructions`-feltet i Responses API | client.ts:418-430 |
| K | Systemprompten er ensidigt "gør det, spørg aldrig" → model gætter og opfinder i stedet for at verificere; ingen regel om at svare på rene spørgsmål ved at læse kode | i18n.ts:92 |
| L | HA-bearer-token i klartekst i `~/.config/lcc/mcp.json` og i argv (synligt i `ps`) | mcp.json |

## Anbefalede forbedringer (prioriteret)
### 1. Ærlighed / verifikation (størst effekt)
- **Claim-guard** i `sendAgent` før `onDone`: hvis sluttekst matcher `/commit|push|rettet|fixed|deploy/` men turen ikke indeholder et matchende `bash`-kald (`git commit`, `git push`) med exit 0 → injicer user-besked "Du påstod X men kørte det ikke. Kør det eller ret dit svar." (genbrug auto-continue-mekanismen, max 1 gang).
- **"Stadig ikke virker"-detektor** i repl.ts: matcher brugerinput som `stadig|still|virker ikke|samme` → tilføj automatisk instruktion "Læs de filer du ændrede sidst og den relevante log før du svarer", og gennemtving at første tool-kald er `read_file`/`bash` (afvis tekst-only svar én gang).
- Efter `edit_file` på PHP: kør udover `php -l` også en hurtig "kald til ikke-eksisterende metode"-check er svært — i stedet: tilføj valgfri post-edit hook (fx `sail artisan test --filter` eller `phpstan` hvis installeret) konfigurerbar i addon.

### 2. Auto-continue
- Fjern kravet `turnToolItems.length > 0`; fortsæt også rene tekst-ture der ender med intention ("Jeg vil…", "Lad mig…") når tools er tilgængelige.
- Undtag svar hvor brugerens besked var et spørgsmål (slutter med `?`) og svaret ikke lover handling.

### 3. Fart og responsivitet
- Fjern 3 s-sleep (eller kun ved 429 med backoff).
- Stream også follow-up-kald (`streamResponses` for alle round-trips).
- `bash` → asynkron `spawn` med AbortSignal, konfigurerbar timeout (default 120 s, `timeout`-parameter i tool-definitionen), live stdout i terminalen.

### 4. Sikkerhed
- Bekræftelses-prompt i REPL før destruktive kommandoer (regex-liste: `push.*(-f|--force)`, `reset --hard`, `rm -rf`, `migrate:fresh`, `DROP`), med `/yolo` til at slå fra.
- Flyt MCP-tokens til env-variabler (`${HA_TOKEN}`-substitution i mcp.json).

### 5. Værktøjer
- `grep`: rapportér regex-fejl, default `--exclude-dir={vendor,node_modules,.git,storage}`, brug `rg` hvis tilgængelig.
- Tilføj `glob`/find-tool; lad `edit_file` understøtte `replace_all`.
- Fejl udelukkende via `isError` (drop prefix-regex G).

### 6. Kontekst
- Brug `instructions`-feltet til systemprompt (J).
- Ved >80k tegn: lad advisor-modellen opsummere ældste del af historikken til én besked i stedet for blot at kappe tool-outputs.
- Justér systemprompt (K): tilføj "Ved spørgsmål: læs koden og svar med fil:linje — gæt ikke", "Kald aldrig metoder du ikke har set defineret (grep først)", "Bed om bekræftelse før force-push/destruktive git-operationer".

## Kritiske filer
- `~/.lcc/src/client.ts` (sendAgent, compressInputHistory, buildContextPrefix)
- `~/.lcc/src/tools.ts` (execBash, execGrep, toolDefinitions)
- `~/.lcc/src/repl.ts` (input-håndtering, bekræftelser)
- `~/.lcc/src/i18n.ts` (ctx.system, nye beskeder på da/en)

## Verifikation
- `cd ~/.lcc && npm run build` (tsc uden fejl).
- Manuel test i camfort med `npm run dev`: (a) "commit & push" uden ændringer → skal ikke påstå commit; (b) spørgsmål "hvor serveres /streams?" → skal grep'e og svare med fil:linje; (c) `git push --force` → skal bede om bekræftelse; (d) tur med 5 tool-kald skal ikke længere tage +15 s; (e) Ctrl-C under langvarig bash afbryder.
