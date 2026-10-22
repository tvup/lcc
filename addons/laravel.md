---
name: laravel
description: Laravel framework context and conventions
detect:
  file: composer.json
  contains: laravel/framework
---

Du arbejder i et Laravel-projekt.

Struktur:
- app/Models/ — Eloquent-modeller
- app/Http/Controllers/ — Controllere
- app/Http/Middleware/ — Middleware
- app/Services/ — Service-klasser
- app/Providers/ — Service providers
- routes/web.php, routes/api.php — Routes
- resources/views/ — Blade-templates
- database/migrations/ — Migrationer
- database/seeders/ — Seeders
- config/ — Konfigurationsfiler
- tests/Feature/, tests/Unit/ — Tests

Konventioner:
- Brug `php artisan` til scaffolding: make:model, make:controller, make:migration osv.
- Eloquent-relationer defineres i model-klasser (hasMany, belongsTo, etc.)
- Form requests til validering: app/Http/Requests/
- Policies til authorization: app/Policies/
- Events og listeners i app/Events/ og app/Listeners/
- Jobs i app/Jobs/ — dispatch via dispatch() helper
- Brug config() helper i stedet for env() udenfor config-filer
- Blade-templates: @extends, @section, @yield, @include, @component
- Eloquent scopes for genbrugelige queries
- Resource controllers med --resource flag
- API resources i app/Http/Resources/ for JSON-transformering

Vigtige kommandoer:
- php artisan migrate — kør migrationer
- php artisan tinker — interaktiv REPL
- php artisan route:list — vis alle routes
- php artisan queue:work — start queue worker
- composer test — kør tests (alias for php artisan test)
