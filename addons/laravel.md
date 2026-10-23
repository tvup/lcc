---
name: laravel
description: Behavioral rules for working in Laravel projects
detect:
  file: composer.json
  contains: laravel/framework
---

Du arbejder i et Laravel-projekt.

## Før du ændrer noget

Læs disse filer for at forstå projektet:
- `composer.json` — hvilke pakker er installeret (Livewire? Inertia? Filament? Sanctum? Spatie?)
- `routes/web.php` og `routes/api.php` — routing-struktur
- `config/app.php` — providers og aliases
- `.env` — miljøkonfiguration (QUEUE_CONNECTION, DB_CONNECTION, etc.)

Tjek om projektet bruger Laravel Sail: kig efter `laravel/sail` i `composer.json`, eller `laravel.test` service i `docker-compose.yml` eller `compose.yml`. Hvis Sail bruges, præfiks ALLE kommandoer med `./vendor/bin/sail` i stedet for direkte `php`/`composer`/`node` — f.eks. `./vendor/bin/sail artisan migrate` i stedet for `php artisan migrate`.

Kør `php artisan route:list --json` (eller via Sail) for at forstå API-strukturen før du rører routes.

## Regler

- Opret ALDRIG en migration der ændrer en eksisterende migrations-fil. Lav altid en NY migration. Kør `php artisan migrate` efter oprettelse for at verificere.
- Brug ALDRIG `env()` udenfor config-filer — brug `config()` helper.
- Brug aldrig `DB::raw()` med bruger-input uden bindings.
- Tilføj altid `$fillable` eller `$guarded` på Eloquent-modeller.
- Tjek om projektet bruger Pest eller PHPUnit inden du skriver tests. Brug `RefreshDatabase` trait.

## Verifikation efter ændringer

- PHP-syntaks tjekkes automatisk efter edit/write — ret fejl med det samme.
- Når du bruger `route()`: kør `bash` med `php artisan route:list --name=<route>` for at verificere at routen eksisterer.
- Når du kalder en metode på en model/service: grep efter metoden for at sikre den findes.
- Når du refererer en Blade-view: tjek at filen eksisterer med `read_file` eller `list_files`.
- Kør `php artisan test --filter=TestName` efter ændringer for at verificere.

## Ved fejl

- Tjek `storage/logs/laravel.log` FØRST.
- Kør `php artisan config:clear && php artisan cache:clear && php artisan route:clear` hvis konfigurationsændringer ikke slår igennem.
- Tjek `QUEUE_CONNECTION` i `.env` — er det `sync`, kører jobs ikke asynkront.
