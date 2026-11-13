# Linia produkcyjna KT5 – harmonogram projektu

Strona do śledzenia postępu projektu studenckiego „Linia produkcyjna KT5”
(program PLC, wizualizacja HMI, schematy elektryczny, pneumatyczny i hydrauliczny, kosztorys).
Termin końcowy: **29.01.2027**.

Strona: https://jakubgasiorowski2lo1-pixel.github.io/projekt-kt5/

## Jak to działa

- Czysty HTML/CSS/JS, bez backendu, hostowane na GitHub Pages (gałąź `main`, folder `/`).
- Wszystkie dane (zespół, zadania, postęp, notatki, bufory, historia zmian) są w `data.json`.
- Strona czyta `data.json` przez GitHub Contents API (zawsze najświeższa wersja), a gdy API nie odpowiada, z pliku obok strony.
- Oglądać może każdy. Do edycji trzeba się zalogować tokenem GitHub **classic** z zakresem `public_repo`
  ([utwórz token](https://github.com/settings/tokens/new?scopes=public_repo&description=KT5%20harmonogram)).
  Konto musi być Collaboratorem repozytorium. Token zostaje tylko w localStorage przeglądarki.
- Każda zmiana to osobny commit `[harmonogram] …`. Przy konflikcie (409/422) strona pobiera świeże dane i nakłada zmianę ponownie.

## Co można robić na stronie

- **Kliknąć zadanie**: szczegóły; po zalogowaniu edycja nazwy, dat, osób, postępu i notatek.
- **+ Dodaj zadanie**: nowe zadanie z przedziałem dat. Numer typu `5.5` ustawia je pod zadaniem 5.
  Opcja „Zadanie niezaplanowane” oznacza je fioletową ramką i pozwala odjąć jego czas od bufora.
- **+ Dodaj bufor**: rezerwa czasu na obsuwy i zadania niezaplanowane (numer `B1`, `B2`…).
- **Przesunięcie końca zadania na później** to obsuwa: na wykresie widać przerywany prostokąt pierwotnego planu
  i pomarańczową kreskowaną część „ponad plan”. Jeśli to świadoma zmiana planu, zaznacz „To zmiana planu, nie obsuwa”.
- **Bufor liczy się sam**, w piątkach (dniach zajęć z `project.classDays`, bez `project.noClassDates`).
  Pojemność = liczba piątków w okresie bufora. Zużycie = obsuwy zadań (piątki między końcem z planu a obecnym końcem)
  + zadania po terminie i nieukończone (piątki od końca do dziś) + całe zadania niezaplanowane + ręczna korekta.
  Liczone są tylko najniższe zadania (np. 7.4, a nie 7). Zadanie trafia do najbliższego bufora po swoim terminie,
  chyba że w oknie zadania wybierzesz inny bufor albo „nie odliczaj”.

## Oznaczenia

| Oznaczenie | Znaczenie |
|---|---|
| pełny kolor w pasku | zrobiony postęp (%) |
| pomarańczowe paski | obsuwa: aktualny koniec jest później niż w planie bazowym |
| czerwone paski za zadaniem | **po terminie**: minęła data końca, a postęp < 100% |
| żółta ramka, „zagrożone” | postęp o 30 p.p. lub więcej za planem (liniowo w czasie) |
| szary kreskowany pasek | bufor; żółte wypełnienie to zużyte dni, czerwone to przekroczony bufor |
| przerywana ramka | pierwotny plan, gdy daty zostały zmienione |
| czerwona linia / czarna przerywana | dziś / termin końcowy |

## Pliki

- `index.html`, `style.css`, `app.js` – strona
- `config.js` – właściciel/repo (wykrywane z adresu `login.github.io/repo`), gałąź, próg „zagrożone”
- `data.json` – dane projektu
- `.nojekyll` – wyłącza Jekylla na GitHub Pages

## Format zadania w `data.json`

```json
{ "id": "5.1", "name": "…", "type": "task", "start": "2026-11-02", "end": "2026-11-20",
  "baselineStart": "2026-11-02", "baselineEnd": "2026-11-20",
  "owners": ["s1", "s2"], "progress": 0, "notes": "", "unplanned": false }
```

Opcjonalnie w zadaniu: `"hours"` (szacowany czas), `"buffer"` (id bufora albo `"none"`).
Bufor: `"type": "buffer"`, opcjonalnie `extraDays` (ręczne zużycie w piątkach). Zużycie bufora nie jest zapisywane, strona liczy je na bieżąco.
