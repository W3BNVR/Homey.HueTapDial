# Hue Tap Dial Events for Homey

Deze Homey-app voegt de Philips Hue Tap Dial Switch toe als apart apparaat en biedt drie apparaatstriggers:

- **Kort indrukken**
- **Lang indrukken**
- **Dubbelklik**
- **Draaiknop gedraaid**

De drie knoptriggers laten je knop 1, 2, 3 of 4 kiezen. De draaiknoptrigger geeft richting, stapjes, duur en start/herhaalstatus door als Flow-tags. De integratie luistert naar de gebeurtenissen van de Hue Bridge v2 API; de Tap Dial moet dus al met een Hue Bridge zijn gekoppeld.

## Instellen

1. Installeer de app op Homey Pro of Homey Self-Hosted Server.
2. Open de appinstellingen en vul het IP-adres van de Hue Bridge in.
3. Kies **Hue Bridge verbinden**. De app vraagt je daarna op de ronde linkknop van de Bridge te drukken; bevestig vervolgens met **Ik heb gedrukt**.
4. Voeg via **Apparaat toevoegen** de Hue Tap Dial Switch toe.
5. Maak een Flow met een van de triggers en selecteer de gewenste knop.

De app vraagt de Bridge zelf om een application key nadat je de linkknop hebt ingedrukt. De sleutel wordt opgeslagen in de Homey-appinstellingen.

## Opmerkingen

- De Bridge gebruikt een lokaal zelfondertekend TLS-certificaat; de app accepteert dat certificaat voor verbinding met het opgegeven Bridge-adres.
- De Hue Bridge levert gebeurtenissen via zijn eventstream. De integratie stuurt alleen `short_release`, `long_release` en `double_short_release` door als Homey-triggers.
- Als de Bridge of het netwerk tijdelijk niet bereikbaar is, probeert de app de eventstream automatisch opnieuw te verbinden.
