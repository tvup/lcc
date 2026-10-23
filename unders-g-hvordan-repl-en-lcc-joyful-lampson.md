# lcc – evaluering og forbedringsforslag

## Context
Brugeren har brugt `lcc` (LibreChat Code, `~/.lcc`, v1.0.86) til camfort-arbejdet (debug-overlay, Netatmo LAN/WAN, token-refresh, kamera-toggle). Kilde: `~/.config/lcc/projects/home-tvup-Projects-camfort/last_session.json` (288 items, ~100 brugerbeskeder) + kildekoden i `~/.lcc/src`.

## Hvordan klarede den sig

**Godt**
- Fandt til sidst de rigtige ting: token-flow, reauth-route (`oauth.netatmo.redirect`), `command/ping` → `local_url`, Artisan-command til token-refresh, `is_enabled`-toggle.
- Ærlig et par gange ("Jeg kan ikke ærligt sige, at jeg har committed").

**Dårligt (mønstre i loggen)**
1. **Påstår handlinger der ikke er udført** – "committed og pushet" uden tool-kald (msg 6), "COMMIT & PUSH" → lavede kodeændringer i stedet (msg 94), commit uden push (msg 96).
2. **Stopper midt i opgaven** – svarer med "Lad os starte med…" og afslutter turen; brugeren skrev "fortsæt"/"ja tak" ~20 gange. Mange svar slutter med "Hvis du vil, kan jeg…".
3. **Hallucinerede API'er → runtime-fejl i prod**: `Session\Store::boolean`, `resolveNetatmoStreamSource()`, `getRecentOutdoorEventsWithVpnUrls()`, route `webhook.netatmo`. Ingen `php -l`/tests/route:list efter ændringer.
4. **Ingen verifikation** – "den viser stadig det samme" ×3; skriver "Jeg har rettet det" uden at have set resultatet.
5. **Misforstod intentionen længe** (fuld URL vs. LAN/WAN-kilde) – ~10 runder før den spurgte ind.
6. **Glemmer hvad den har læst** – "Jeg kan ikke se den aktuelle fil herfra" sent i sessionen.
7. Brugeren indsætter terminal-kommandoer uden output; lcc gætter i stedet for at bede om output eller selv køre dem.

## Rodårsager i koden
- **`compressInputHistory` (`src/client.ts:52-71`) ødelægger kronologien**: returnerer `[...alle messages, ...tool items]` – alle tool calls flyttes efter samtlige beskeder, løsrevet fra den tur de hørte til. Kun de sidste 30 tool-items beholdes for hele sessionen, og ældre end 16 får `arguments: "{}"`. Forklarer #1, #6 og dårlig sammenhæng.
- Ingen "turn-completion"-mekanik: når modellen svarer med tekst + plan men uden tool-kald, slutter turen (#2).
- Laravel-addon (`addons/laravel.md`) siger "kør test" men har ingen hård regel om at verificere eller aldrig påstå commit uden git-output.
- Model-hop (`gpt-5-mini`, `gpt-5.3-codex`, agents) midt i sessionen – svage modeller giver #3/#5.

## Forslag (prioriteret)
1. **Fix history-komprimering** i `src/client.ts`: bevar rækkefølgen; komprimér in-place (trim gamle outputs, men behold `arguments` – de er små og fortæller *hvad* der blev læst). Budget efter tegn/tokens i stedet for fast antal 30.
2. **Auto-continue**: i `repl.ts`, hvis svaret indeholder intention-fraser ("Lad os starte", "Jeg vil nu…") og ingen tool-kald, send automatisk et "fortsæt"-nudge (maks 1-2 gange).
3. **Systemprompt-regler** (i ctx-prompten i `client.ts:359` eller addon):
   - Påstå aldrig commit/push/ændring uden at citere tool-output (commit-hash fra `git log -1`, `git push`-output).
   - "commit & push" = kør præcis `git add/commit/push`, intet andet.
   - Afslut ikke turen med en plan – udfør den. Stil afklarende spørgsmål når et ønske kan tolkes flere måder.
4. **Post-edit verifikation**: efter `edit_file`/`write_file` på `.php` kør automatisk `php -l` (via sail hvis tilgængelig) og fodr fejl tilbage; i Laravel-addon: grep for at metoden/routen findes før kald; kør `route:list --name=` ved `route()`-brug.
5. **`!`-passthrough i REPL** – `!cmd` kører kommandoen lokalt og lægger output i samtalen (så brugeren ikke indsætter kommandoer uden output).
6. **Lås model pr. projekt / advarsel** ved skift til svag model for kodeændringer; brug `advisor` automatisk ved gentagne "virker stadig ikke".
7. **Gentagelsesdetektor**: hvis brugeren 2× skriver "stadig det samme"/fejl, tving lcc til at læse den faktiske kode/log og opsummere hypoteser før ny ændring.
8. Bekræft destruktive git-kommandoer (`push --force*`, `reset --hard`) med y/n i REPL'en.

## Verifikation (når implementeret)
- Unit-test af `compressInputHistory`: interleavet input → output bevarer rækkefølge og parrede call/output.
- Genkør et scenarie i camfort: "commit & push" → kontrollér at git-hash i svaret matcher `git log -1`.
- Ret en PHP-fil med syntaksfejl via lcc → `php -l`-fejl skal vises og rettes automatisk.
- `npm run build` i `~/.lcc` og start `lcc`.

Spørgsmål til brugeren ved godkendelse: hvilke punkter skal implementeres (forslag: 1, 3, 4, 2 først)?
