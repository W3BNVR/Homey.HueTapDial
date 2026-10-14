# Hue Tap Dial Events for Homey

Deze Homey-app voegt de Philips Hue Tap Dial Switch toe als apart apparaat en biedt twee apparaatstriggers:

- **Knop ingedrukt** — selecteer knop 1–4 en kies Enkel of Lang indrukken.
- **Draaiknop gedraaid**

De draaiknoptrigger geeft richting, stapjes, duur en start/herhaalstatus door als Flow-tags. De integratie luistert naar de gebeurtenissen van de Hue Bridge v2 API; de Tap Dial moet dus al met een Hue Bridge zijn gekoppeld.

## Instellen

1. Installeer de app op Homey Pro of Homey Self-Hosted Server.
2. Open de appinstellingen en vul het IP-adres van de Hue Bridge in.
3. Kies **Hue Bridge verbinden** en druk op de ronde linkknop van de Bridge. De app detecteert de druk automatisch.
4. Voeg via **Apparaat toevoegen** één of meerdere Hue Tap Dial Switches toe.
5. Maak een Flow met **Knop ingedrukt** en kies de gewenste knop en actie.

De app vraagt de Bridge zelf om een application key nadat je de linkknop hebt ingedrukt. De sleutel wordt opgeslagen in de Homey-appinstellingen.

## Opmerkingen

- De Bridge gebruikt een lokaal zelfondertekend TLS-certificaat; de app accepteert dat certificaat voor verbinding met het opgegeven Bridge-adres.
- De Hue Bridge levert gebeurtenissen via zijn eventstream. De integratie stuurt `short_release` en `long_release` door als Homey-triggers. De Hue Tap Dial levert geen bruikbaar dubbelklik-event via deze eventstream.
- Als de Bridge of het netwerk tijdelijk niet bereikbaar is, probeert de app de eventstream automatisch opnieuw te verbinden.
