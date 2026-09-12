//
//  i18n.ts
//  HIVE (client)
//
//  Two languages, one object each. The toggle is remembered per phone.
//

export type Lang = 'en' | 'de';

const strings = {
  en: {
    tagline: 'Swarm audio. Your phone becomes one voice in a swarm — its tilt and movement are turned into sound.',
    join: 'Join the swarm',
    joining: 'Joining…',
    leave: 'Leave',
    yourName: 'Name (optional)',
    youAre: 'you are',
    streaming: 'streaming',
    connecting: 'connecting…',
    reconnecting: 'reconnecting…',
    disconnected: 'disconnected',
    transport: 'link',
    rate: 'rate',
    keepOpen: 'Keep this page open and the screen on. Move, tilt, turn.',
    acc: 'accelerometer (m/s²)',
    gyro: 'gyroscope (°/s)',
    errInsecure: 'This page was opened over plain HTTP. Phones only share motion sensors over HTTPS — scan the QR code again and make sure the address starts with https://.',
    errUnsupported: 'This browser does not expose motion sensors (no DeviceMotionEvent). Try Safari on iPhone or Chrome on Android.',
    errDenied: 'Motion access was denied. On iPhone: reload the page and tap Allow — or check Settings → Safari → Motion & Orientation Access. On Android: check the site permissions in Chrome.',
    errNoData: 'No sensor data is arriving. Is this a laptop? Motion sensors are only in phones and tablets.',
    errServer: 'Cannot reach the server. Are you on the same Wi-Fi as the Mac running HIVE?',
    retry: 'Try again',
    credit: 'HIVE · Music & AI Hackathon 2026',
  },
  de: {
    tagline: 'Swarm Audio. Dein Handy wird eine Stimme im Schwarm — Neigung und Bewegung werden zu Klang.',
    join: 'Dem Schwarm beitreten',
    joining: 'Beitreten…',
    leave: 'Verlassen',
    yourName: 'Name (optional)',
    youAre: 'du bist',
    streaming: 'sendet',
    connecting: 'verbinde…',
    reconnecting: 'verbinde neu…',
    disconnected: 'getrennt',
    transport: 'Verbindung',
    rate: 'Rate',
    keepOpen: 'Lass die Seite offen und den Bildschirm an. Beweg dich, neige, dreh.',
    acc: 'Beschleunigung (m/s²)',
    gyro: 'Gyroskop (°/s)',
    errInsecure: 'Diese Seite wurde über HTTP geöffnet. Handys geben Bewegungssensoren nur über HTTPS frei — scanne den QR-Code erneut und achte darauf, dass die Adresse mit https:// beginnt.',
    errUnsupported: 'Dieser Browser bietet keine Bewegungssensoren (kein DeviceMotionEvent). Versuch Safari am iPhone oder Chrome unter Android.',
    errDenied: 'Zugriff auf Bewegungsdaten wurde verweigert. iPhone: Seite neu laden und „Erlauben" tippen — oder Einstellungen → Safari → „Bewegung & Ausrichtung" prüfen. Android: Website-Berechtigungen in Chrome prüfen.',
    errNoData: 'Es kommen keine Sensordaten. Ist das ein Laptop? Bewegungssensoren gibt es nur in Handys und Tablets.',
    errServer: 'Server nicht erreichbar. Bist du im selben WLAN wie der Mac, auf dem HIVE läuft?',
    retry: 'Nochmal versuchen',
    credit: 'HIVE · Music & AI Hackathon 2026',
  },
} as const;

export type Key = keyof typeof strings.en;

let current: Lang = (localStorage.getItem('hive.lang') as Lang | null)
  ?? (navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en');

export const lang = (): Lang => current;
export const t = (key: Key): string => strings[current][key];
export function setLang(l: Lang): void {
  current = l;
  localStorage.setItem('hive.lang', l);
  document.documentElement.lang = l === 'de' ? 'de-AT' : 'en-GB';
}
