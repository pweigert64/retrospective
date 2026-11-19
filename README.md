# Alpine Retrospective | Digitales Tourenbuch

**Live Website:** [(https://pweigert64.github.io/retrospective/)]

This repository contains the core logic for the **Alpine Retrospective**, a hybrid chronological and geographic archive of my mountaineering and cycling activities. 

### 🏔️ Regions Covered
Based in **Linz, Austria**, this project documents extensive exploration of:
* **Nördliche Kalkalpen:** Totes Gebirge, Gesäuse, Dachstein, Hochkönig, Tennengebirge, Loferer und Leoganger Steinberge, Wilder Kaiser.
* **Niedere Tauern:** Triebener Tauern, Rottenmanner Tauern, Wölzer Tauern, Schladminger Tauern
* **Hohe Tauern**  
* **Zillertaler Alpen** 
* **Stubaier ALpen** 
* **Ötztaler Alpen**
* **Dolomiten**
* **Walliser Alpen**
* **Berner Oberland**
* **Ortler**
* **Cycling:** Local routes in the **Mühlviertel** and rail-integrated tours across Austria via **Klimaticket**.

### 🛠️ Technical Architecture
* **Frontend:** Vanilla JS / Leaflet (mapping the Alps).
* **Database:** [Google Sheets Data Source](https://docs.google.com/spreadsheets/d/e/2PACX-1vR1jF7J6Z5u8hbOCka2VFlVSnughkNsAdCfdvigbW4ioJaM1rkMgxxz8FW38Jhq7q32kq23EhFMUOPa/pubhtml?gid=0&single=true).
* **Assets:** High-resolution **WebP images** and **GPX tracks** are hosted in the consolidated [Alpine Data Vault](https://github.com/pweigert64/alpine-data-vault).

### Trip coordinates
Trip collection headers do not need a latitude or longitude when a single point would misrepresent a trip across multiple regions. Leave the header coordinates blank; the map action uses coordinates and GPX tracks from the trip's entries instead. A trip with neither entry coordinates nor GPX tracks is not offered as mappable. No representative center point is inferred.

Text searches in the portal also match a trip when the keyword appears in one of its entries, including that entry's tags.

For records with the same `tripid`, any missing or non-link `album` value inherits the first album URL found on that trip. Explicit album URLs on individual records are preserved.

### Activity categories
`climb` means roped climbing, `scramble` means unroped climbing, and `alpine` means an alpine tour (Hochtour). The legacy sheet value `rope` is normalized to `climb`; `climb` and `scramble` remain distinct categories. Filter buttons, portal and map icons, marker colors, and track colors all use these categories.

The activity filters start with all categories enabled. Clicking an activity while all are enabled selects only that activity; subsequent clicks add or remove categories. The **alle aktiv** checkbox enables or disables all activity filters.

### 🔍 Search Keywords
Austrian Alps, Hiking GPX Tracks, Mapping, Skitouren, Bike & Rail, Bike & Hike, Linz, Bergsteigen, Klettern, Wandern, Scrambling, Hochtouren, Alpen, Totes Gebirge, Gesäuse, Dachstein, Hochkönig, Tennengebirge, Gosaukamm, Tauern.

### Deep Links
Use `?s=<title>` to open an activity with a literal search. Use `?re=<pattern>` for a case-insensitive regular-expression search. The optional `view` parameter selects the initial view: `view=map` (default) or `view=portal`. When the map view finds exactly one result, its popup opens automatically, including when its GPX track is shown.

Examples: `?s=Kraxenberg&view=portal` or `?re=Krax(en|enberg)&view=map`.
