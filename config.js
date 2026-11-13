// Konfiguracja strony.
// Właściciel i nazwa repo są wykrywane automatycznie z adresu login.github.io/repo.
// Wpisz je ręcznie tylko wtedy, gdy strona działa pod innym adresem (np. lokalnie).
window.KT5_CONFIG = {
  owner: "",          // np. "jakubgasiorowski2lo1-pixel"
  repo: "",           // np. "projekt-kt5"
  branch: "main",
  path: "data.json",
  // Używane, gdy automatyczne wykrywanie nie zadziała (np. podgląd lokalny).
  fallbackOwner: "jakubgasiorowski2lo1-pixel",
  fallbackRepo: "projekt-kt5",
  // Próg „zagrożone”: postęp o tyle punktów procentowych za planem.
  riskThreshold: 30
};
